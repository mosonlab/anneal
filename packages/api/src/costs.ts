import {
  MERGE_TAIL_KIND,
  MODEL_TOKEN_PRICES,
  Prisma,
  RunStatus,
  TaskStatus,
  modelNameForPricing,
  runSessionUsageCost,
  type PrismaClient,
  type UsageCost,
} from "@anneal/db";
import type {
  CostsChain as CostsChainContract,
  CostsReport as CostsReportContract,
} from "@anneal/db/board-contract";
import type { SerializesTo } from "@anneal/db/wire-serialization";
import { stepRole, type StepRole } from "@anneal/db/merge-integrator";

import {
  chainDisplayByTask,
  repairChainBindingsFromRows,
  type RepairMarkerRow,
} from "./board.js";
import { terminalRunStatuses } from "./workspace-reclaim.js";

/**
 * Spend aggregation for the Costs dashboard.
 *
 * Detailed settled rows own both counts and amounts because `Session.costUsd`
 * is NULL for every Codex session and estimates come from token columns. Chain
 * history is loaded in the same transaction and joined in memory, with one
 * bounded read per table rather than one query per Chain or Task.
 *
 * TOKEN NORMALIZATION. `Session.totalTokens` is never read here: it is a
 * display projection, not the pricing basis. New persisted rows use the
 * canonical input split (`inputTokens`, `cachedInputTokens`,
 * `cacheCreationInputTokens`, `outputTokens`), where `inputTokens` includes
 * both cache subsets. `runSessionUsageCost` prices that split directly; rows
 * missing any pricing input remain explicitly unavailable.
 */

export const COSTS_DEFAULT_DAYS = 30;
/** The ranges the dashboard offers. Anything else is refused rather than
 *  silently clamped, so a mistyped URL cannot be read as a real window. */
export const COSTS_RANGE_DAYS: readonly number[] = [1, 7, 30, 90];
export const COSTS_TOP_RUNS = 10;

/** Aggregate amounts are rounded here before serialization. `Session.costUsd`
 *  is `Decimal(12, 4)`, so this keeps provider-reported sums exact while still
 *  bounding the tail an estimate's division produces. */
const AMOUNT_DECIMALS = 6;

export type CostsRunRow = {
  id: string;
  taskId?: string | null;
  model: string;
  status: RunStatus;
  subagentModel: string | null;
  startedAt: Date | null;
  endedAt?: Date | null;
  cancelRequestId?: string | null;
  failureClass?: string | null;
  agent: { id: string; name: string };
  task: CostsTaskRow | null;
  session: {
    nativeChildUsed: boolean;
    costUsd: Prisma.Decimal | null;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    cacheCreationInputTokens: number | null;
    outputTokens: number | null;
  } | null;
};

export type CostsTaskRow = {
  id: string;
  projectId: string;
  name: string;
  status: TaskStatus;
  chainId: string | null;
  chainIndex: number | null;
  chainLayer: number | null;
  templateStep: { name: string; outputKind: string } | null;
  /** Set only for a detached merge-tail repair after the marker binding has
   * been resolved. Primary Chain tasks leave it absent. */
  repairKind?: string;
  /** The primary Chain id resolved from the repair marker. Detached repairs
   * intentionally keep `chainId` null in the persisted Task shape. */
  repairChainId?: string;
};

export type CostsChainData = {
  tasks: readonly CostsTaskRow[];
  /** All project runs, not only the selected spend window. */
  runs: readonly CostsRunRow[];
  until: Date;
};

/** The report as this module builds it, and the proof that JSON serialization
 * turns it into exactly the browser contract: every `Prisma.Decimal` amount
 * reaches the browser as a string, `since` and every top run start as an ISO
 * string, and no key is carried that the contract does not name. */
export type CostsResponse = SerializesTo<CostsReportContract<Date, Prisma.Decimal>, CostsReportContract>;

type NativeCostsChain = CostsChainContract<Prisma.Decimal>;

const ZERO = new Prisma.Decimal(0);

const amount = (value: Prisma.Decimal): Prisma.Decimal => value.toDecimalPlaces(AMOUNT_DECIMALS);

/** Round a partition at wire precision without letting independently rounded
 *  rows disagree with their rounded total. Largest remainders receive the
 *  remaining micro-units, with source order as the deterministic tie-breaker. */
const partitionAmounts = (values: readonly Prisma.Decimal[], total: Prisma.Decimal): Prisma.Decimal[] => {
  const scale = new Prisma.Decimal(10).pow(AMOUNT_DECIMALS);
  const allocations = values.map((value, index) => {
    const scaled = value.times(scale);
    const units = scaled.floor();
    return { index, units, remainder: scaled.minus(units) };
  });
  const targetUnits = total.times(scale).toDecimalPlaces(0);
  let allocatedUnits = allocations.reduce((sum, entry) => sum.plus(entry.units), ZERO);
  const byRemainder = [...allocations]
    .sort((left, right) => right.remainder.comparedTo(left.remainder) || left.index - right.index);
  for (const entry of byRemainder) {
    if (allocatedUnits.greaterThanOrEqualTo(targetUnits)) break;
    entry.units = entry.units.plus(1);
    allocatedUnits = allocatedUnits.plus(1);
  }
  if (!allocatedUnits.equals(targetUnits)) {
    throw new Error("Could not reconcile rounded cost partition");
  }
  return allocations.map((entry) => entry.units.dividedBy(scale));
};

type CalendarParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const calendarFormatters = new Map<string, Intl.DateTimeFormat>();

const calendarFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const existing = calendarFormatters.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  calendarFormatters.set(timeZone, formatter);
  return formatter;
};

export const isValidTimeZone = (timeZone: string): boolean => {
  if (timeZone.trim() === "") return false;
  try {
    calendarFormatter(timeZone).format(new Date(0));
    return true;
  } catch {
    return false;
  }
};

const calendarParts = (value: Date, timeZone: string): CalendarParts => {
  const values = Object.fromEntries(
    calendarFormatter(timeZone).formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const required = (key: keyof CalendarParts): number => {
    const part = values[key];
    if (part === undefined) throw new Error(`Timezone formatter omitted ${key}`);
    return part;
  };
  return {
    year: required("year"),
    month: required("month"),
    day: required("day"),
    hour: required("hour"),
    minute: required("minute"),
    second: required("second"),
  };
};

const dateKey = ({ year, month, day }: Pick<CalendarParts, "year" | "month" | "day">): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const localDay = (value: Date, timeZone: string): string => dateKey(calendarParts(value, timeZone));

const shiftCalendarDate = (
  parts: Pick<CalendarParts, "year" | "month" | "day">,
  days: number,
): Pick<CalendarParts, "year" | "month" | "day"> => {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};

/** Resolve the start of a local calendar date to its UTC instant. Usually this
 *  is midnight; if a DST transition skips midnight, it is the first valid
 *  instant of the requested date instead. */
const localMidnight = (
  parts: Pick<CalendarParts, "year" | "month" | "day">,
  timeZone: string,
): Date => {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const target = dateKey(parts);
  const offsets = new Set<number>();
  // A nonexistent midnight makes offset iteration oscillate across the gap.
  // Probe both sides of any nearby transition and test each actual offset.
  for (let hours = -48; hours <= 48; hours += 6) {
    const instant = localAsUtc + (hours * 60 * 60 * 1_000);
    const observed = calendarParts(new Date(instant), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second,
    );
    offsets.add(observedAsUtc - instant);
  }
  const candidates = [...offsets]
    .map((offset) => new Date(localAsUtc - offset))
    .sort((left, right) => left.getTime() - right.getTime());
  for (const candidate of candidates) {
    const observed = calendarParts(candidate, timeZone);
    if (dateKey(observed) === target
      && observed.hour === 0 && observed.minute === 0 && observed.second === 0) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (localDay(candidate, timeZone) === target
      && localDay(new Date(candidate.getTime() - 1), timeZone) < target) {
      return candidate;
    }
  }
  throw new Error(`Could not resolve local date ${target} in ${timeZone}`);
};

/** Local midnight `days - 1` calendar days back in the requested timezone. */
export const costsWindowStart = (now: Date, days: number, timeZone: string): Date =>
  localMidnight(shiftCalendarDate(calendarParts(now, timeZone), -(days - 1)), timeZone);

/** The next local midnight, exclusive. This can be 23 or 25 hours after the
 *  current day's start when daylight saving changes. */
export const costsWindowEnd = (now: Date, timeZone: string): Date =>
  localMidnight(shiftCalendarDate(calendarParts(now, timeZone), 1), timeZone);

/** Every local calendar day in the window, oldest first, including empty days. */
const windowDays = (since: Date, days: number, timeZone: string): string[] => {
  const dates: string[] = [];
  const first = calendarParts(since, timeZone);
  for (let offset = 0; offset < days; offset += 1) {
    dates.push(dateKey(shiftCalendarDate(first, offset)));
  }
  return dates;
};

const runCost = (run: CostsRunRow): UsageCost | null => {
  return runSessionUsageCost(run);
};

const isTerminalRunStatus = (status: RunStatus): status is typeof terminalRunStatuses[number] =>
  terminalRunStatuses.includes(status as typeof terminalRunStatuses[number]);

export type CacheSplit = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
};

/** The canonical input-token split rule, over the three persisted columns
 * alone. A split is known only when all three pieces of the canonical input
 * total are present and internally consistent — cached reads and cache writes
 * are subsets of `inputTokens`. A persisted NULL stays unknown.
 *
 * Exported because the per-run diagnostics in `run-metrics.ts` report the same
 * split to an operator; that reader must not re-derive this rule. */
export const inputTokenSplit = (tokens: {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}): CacheSplit | null => {
  const { inputTokens, cachedInputTokens, cacheCreationInputTokens } = tokens;
  if (inputTokens === null || cachedInputTokens === null || cacheCreationInputTokens === null
    || inputTokens < 0 || cachedInputTokens < 0 || cacheCreationInputTokens < 0
    || cachedInputTokens + cacheCreationInputTokens > inputTokens) return null;
  return {
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens - cacheCreationInputTokens,
  };
};

const cacheSplit = (run: CostsRunRow): CacheSplit | null =>
  run.session === null ? null : inputTokenSplit(run.session);

/** The efficiency view prices uncached input at the Run's own model, the same
 * model `runSessionUsageCost` charges the whole aggregate at. Codex reports no
 * per-thread usage, so a native-child Run has no second rate to apply here. */
const uncachedInputUsd = (run: CostsRunRow, split: CacheSplit): Prisma.Decimal | null => {
  const prices = MODEL_TOKEN_PRICES[modelNameForPricing(run.model)];
  return prices === undefined
    ? null
    : new Prisma.Decimal(split.uncachedInputTokens).times(prices.inputPerMillionUsd).dividedBy(1_000_000);
};

type CostsChainTask = CostsTaskRow & { repairKind?: string };

const chainKey = (task: Pick<CostsTaskRow, "projectId" | "chainId">): string =>
  `${task.projectId}\u0000${task.chainId}`;

const boundChainKey = (task: CostsChainTask): string | null => {
  const chainId = task.repairKind === undefined ? task.chainId : task.repairChainId ?? task.chainId;
  return chainId === null || chainId === undefined ? null : `${task.projectId}\u0000${chainId}`;
};

const taskIdOfRun = (run: CostsRunRow): string | null => run.taskId ?? run.task?.id ?? null;

const roleForChainTask = (task: CostsChainTask): StepRole | "repair" | null => {
  if (task.repairKind !== undefined) return "repair";
  const outputKind = task.templateStep?.outputKind;
  return outputKind === undefined ? null : stepRole({ outputKind });
};

const minutes = (milliseconds: number): number => milliseconds / 60_000;

const chainReport = (
  data: CostsChainData,
  since: Date,
  until: Date,
): NativeCostsChain[] => {
  const taskById = new Map(data.tasks.map((task) => [task.id, task]));
  const runsByTask = new Map<string, CostsRunRow[]>();
  for (const run of data.runs) {
    const taskId = taskIdOfRun(run);
    if (taskId === null || !taskById.has(taskId)) continue;
    const taskRuns = runsByTask.get(taskId) ?? [];
    taskRuns.push(run);
    runsByTask.set(taskId, taskRuns);
  }

  const primaryByChain = new Map<string, CostsChainTask[]>();
  for (const task of data.tasks) {
    if (task.chainId === null || task.repairKind !== undefined) continue;
    const key = chainKey(task);
    const group = primaryByChain.get(key) ?? [];
    group.push(task);
    primaryByChain.set(key, group);
  }

  const repairsByChain = new Map<string, CostsChainTask[]>();
  for (const task of data.tasks) {
    if (task.repairKind === undefined) continue;
    const key = boundChainKey(task);
    if (key === null) continue;
    const group = repairsByChain.get(key) ?? [];
    group.push(task);
    repairsByChain.set(key, group);
  }

  const reports: NativeCostsChain[] = [];
  for (const [key, primary] of primaryByChain) {
    const orderedPrimary = [...primary].sort((left, right) => (
      (left.chainLayer ?? Number.MAX_SAFE_INTEGER) - (right.chainLayer ?? Number.MAX_SAFE_INTEGER)
      || (left.chainIndex ?? Number.MAX_SAFE_INTEGER) - (right.chainIndex ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id)
    ));
    const members = [...orderedPrimary, ...(repairsByChain.get(key) ?? [])];
    if (members.some((task) => task.status !== TaskStatus.DONE)) continue;
    const memberRuns = members.flatMap((task) => runsByTask.get(task.id) ?? []);
    if (memberRuns.length === 0) continue;
    // The query reads every project Run, including active rows. A chain is a
    // complete historical object only when no member has an in-flight run.
    if (memberRuns.some((run) => !isTerminalRunStatus(run.status))) continue;
    if (memberRuns.some((run) => {
      const startedAt = run.startedAt;
      const endedAt = run.endedAt ?? null;
      return startedAt === null || endedAt === null || endedAt.getTime() < startedAt.getTime();
    })) continue;
    const orderedRuns = [...memberRuns].sort((left, right) => (
      left.startedAt!.getTime() - right.startedAt!.getTime()
      || (left.endedAt ?? new Date(0)).getTime() - (right.endedAt ?? new Date(0)).getTime()
      || left.id.localeCompare(right.id)
    ));
    const firstStarted = orderedRuns[0]!.startedAt!.getTime();
    const lastEnded = Math.max(...orderedRuns.map((run) => run.endedAt!.getTime()));
    if (lastEnded < since.getTime() || lastEnded >= until.getTime()) continue;

    let busyMilliseconds = 0;
    let longestGapMilliseconds = 0;
    let longestGapTaskName: string | null = null;
    let busyFrontier = firstStarted;
    for (let index = 0; index < orderedRuns.length; index += 1) {
      const run = orderedRuns[index]!;
      busyMilliseconds += run.endedAt!.getTime() - run.startedAt!.getTime();
      const gap = Math.max(0, run.startedAt!.getTime() - busyFrontier);
      if (gap > longestGapMilliseconds) {
        longestGapMilliseconds = gap;
        const task = taskById.get(taskIdOfRun(run) ?? "");
        longestGapTaskName = task?.name ?? run.task?.name ?? null;
      }
      busyFrontier = Math.max(busyFrontier, run.endedAt!.getTime());
    }

    const roleAmounts = new Map<string, Prisma.Decimal>();
    let total = ZERO;
    let pricedRuns = 0;
    let unavailableRuns = 0;
    for (const run of memberRuns) {
      const task = taskById.get(taskIdOfRun(run) ?? "") ?? run.task;
      const role = task === null ? null : roleForChainTask(task);
      const roleBucket = role ?? "unassigned";
      roleAmounts.set(roleBucket, roleAmounts.get(roleBucket) ?? ZERO);
      const cost = runCost(run);
      if (cost?.costUsd === null || cost === null) {
        unavailableRuns += 1;
        continue;
      }
      total = total.plus(cost.costUsd);
      pricedRuns += 1;
      roleAmounts.set(roleBucket, (roleAmounts.get(roleBucket) ?? ZERO).plus(cost.costUsd));
    }
    const roleEntries = [...roleAmounts.entries()].sort(([left], [right]) => left.localeCompare(right));
    const roleValues = partitionAmounts(roleEntries.map(([, value]) => value), total);
    const costByRole = Object.fromEntries(roleEntries.map(([role], index) => [role, roleValues[index]!])) as Record<string, Prisma.Decimal>;
    const chainName = chainDisplayByTask(orderedPrimary.map((task) => ({
      id: task.id,
      projectId: task.projectId,
      name: task.name,
      chainId: task.chainId,
      templateStep: task.templateStep,
    }))).get(orderedPrimary[0]!.id)?.chainName ?? null;
    const repairs = { gateFix: 0, refreshConflict: 0, reviewFix: 0 };
    for (const repair of members.filter((task) => task.repairKind !== undefined)) {
      if (repair.repairKind === "gate-fix") repairs.gateFix += 1;
      else if (repair.repairKind === "refresh-conflict") repairs.refreshConflict += 1;
      else if (repair.repairKind === "review-fix") repairs.reviewFix += 1;
    }
    reports.push({
      chainId: orderedPrimary[0]!.chainId!,
      detailTaskId: orderedPrimary[0]!.id,
      chainName,
      taskCount: orderedPrimary.length,
      leadMinutes: minutes(lastEnded - firstStarted),
      busyMinutes: minutes(busyMilliseconds),
      busyPct: lastEnded === firstStarted ? 0 : (busyMilliseconds / (lastEnded - firstStarted)) * 100,
      repairs,
      costUsd: pricedRuns === 0 ? null : amount(total),
      costByRole: Object.fromEntries(Object.entries(costByRole).map(([role, value]) => [role, amount(value)])),
      costUnavailableRuns: unavailableRuns,
      longestGap: { minutes: minutes(longestGapMilliseconds), beforeTaskName: longestGapTaskName },
    });
  }
  return reports.sort((left, right) => right.leadMinutes - left.leadMinutes || left.chainId.localeCompare(right.chainId));
};

/** Apply the board's detached-repair binding to the one project-wide Task
 * read. The shared resolver keeps its newest-valid-marker rule identical to
 * readRepairChainByTask. */
const bindRepairTasks = (
  tasks: readonly CostsTaskRow[],
  activityRows: readonly RepairMarkerRow[],
): CostsTaskRow[] => {
  const boundByTask = repairChainBindingsFromRows(
    tasks.filter((task) => task.chainId === null),
    activityRows,
    tasks.filter((task) => task.chainId !== null),
  );
  return tasks.map((task) => {
    const binding = boundByTask.get(task.id);
    return binding === undefined
      ? task
      : { ...task, repairKind: binding.repairKind, repairChainId: binding.chainId };
  });
};

export const aggregateCosts = (
  runs: readonly CostsRunRow[],
  since: Date,
  days: number,
  timeZone: string,
  chainData: CostsChainData,
): CostsResponse => {
  const daily = new Map<string, Map<string, Prisma.Decimal>>(
    windowDays(since, days, timeZone).map((date) => [date, new Map<string, Prisma.Decimal>()]),
  );
  const runCountByAgent = new Map<string, number>();
  const perAgent = new Map<string, {
    agent: string;
    usd: Prisma.Decimal;
    pricedRuns: number;
    costUnavailableRuns: number;
    cachedInputTokens: number;
    inputTokens: number;
    uncachedInputTokens: number;
    uncachedInputUsd: Prisma.Decimal;
    cacheKnownRuns: number;
    cachePricingKnown: boolean;
    cacheUnknownRuns: number;
    wastedUsd: Prisma.Decimal;
  }>();
  const perModel = new Map<string, {
    model: string;
    usd: Prisma.Decimal;
    runs: number;
    costUnavailableRuns: number;
  }>();
  const priced: Array<{ run: CostsRunRow; cost: UsageCost & { costUsd: Prisma.Decimal } }> = [];
  let total = ZERO;
  let estimated = ZERO;
  let wasted = ZERO;
  let operatorCancelled = ZERO;
  let failed = ZERO;
  const failedByClass = new Map<string, { usd: Prisma.Decimal; runs: number }>();
  let unavailable = 0;

  for (const run of runs) {
    const startedAt = run.startedAt;
    if (startedAt === null) throw new Error(`Run ${run.id} has no startedAt in a Costs window`);
    const agentId = run.agent.id;
    const agent = run.agent.name;
    runCountByAgent.set(agentId, (runCountByAgent.get(agentId) ?? 0) + 1);
    const cost = runCost(run);
    const agentTotal = perAgent.get(agentId) ?? {
      agent, usd: ZERO, pricedRuns: 0, costUnavailableRuns: 0,
      cachedInputTokens: 0, inputTokens: 0, uncachedInputTokens: 0, uncachedInputUsd: ZERO,
      cacheKnownRuns: 0, cachePricingKnown: true, cacheUnknownRuns: 0, wastedUsd: ZERO,
    };
    const split = cacheSplit(run);
    const withCache = split !== null
      ? {
          ...agentTotal,
          cachedInputTokens: agentTotal.cachedInputTokens + split.cachedInputTokens,
          inputTokens: agentTotal.inputTokens + split.inputTokens,
          uncachedInputTokens: agentTotal.uncachedInputTokens + split.uncachedInputTokens,
          uncachedInputUsd: agentTotal.uncachedInputUsd.plus(uncachedInputUsd(run, split) ?? ZERO),
          cacheKnownRuns: agentTotal.cacheKnownRuns + 1,
          cachePricingKnown: agentTotal.cachePricingKnown && uncachedInputUsd(run, split) !== null,
        }
      : { ...agentTotal, cacheUnknownRuns: agentTotal.cacheUnknownRuns + 1 };
    // Attribute native-child estimates to the root model used to price them.
    const model = run.model;
    const modelTotal = perModel.get(model) ?? { model, usd: ZERO, runs: 0, costUnavailableRuns: 0 };
    const isWasted = run.status !== RunStatus.SUCCEEDED;
    const isOperatorCancelled = isWasted && run.cancelRequestId !== null && run.cancelRequestId !== undefined;
    if (isWasted && !isOperatorCancelled) {
      const failureClass = run.failureClass ?? "unclassified";
      const existing = failedByClass.get(failureClass) ?? { usd: ZERO, runs: 0 };
      failedByClass.set(failureClass, { ...existing, runs: existing.runs + 1 });
    }
    const usd = cost?.costUsd ?? null;
    if (cost === null || usd === null) {
      unavailable += 1;
      perAgent.set(agentId, { ...withCache, costUnavailableRuns: withCache.costUnavailableRuns + 1 });
      perModel.set(model, {
        ...modelTotal, runs: modelTotal.runs + 1, costUnavailableRuns: modelTotal.costUnavailableRuns + 1,
      });
      continue;
    }
    const runWasted = isWasted ? usd : ZERO;
    perAgent.set(agentId, {
      ...withCache,
      usd: withCache.usd.plus(usd),
      pricedRuns: withCache.pricedRuns + 1,
      wastedUsd: withCache.wastedUsd.plus(runWasted),
    });
    perModel.set(model, { ...modelTotal, usd: modelTotal.usd.plus(usd), runs: modelTotal.runs + 1 });
    total = total.plus(usd);
    wasted = wasted.plus(runWasted);
    if (isOperatorCancelled) operatorCancelled = operatorCancelled.plus(usd);
    else if (isWasted) {
      failed = failed.plus(usd);
      const failureClass = run.failureClass ?? "unclassified";
      const existing = failedByClass.get(failureClass)!;
      failedByClass.set(failureClass, { ...existing, usd: existing.usd.plus(usd) });
    }
    if (cost.estimated) estimated = estimated.plus(usd);
    const bucket = daily.get(localDay(startedAt, timeZone));
    // A run outside the buckets cannot happen for rows the query returned, but
    // dropping one silently would make the chart disagree with the tiles.
    if (bucket === undefined) throw new Error(`Run ${run.id} started outside the ${days}-day window`);
    bucket.set(agent, (bucket.get(agent) ?? ZERO).plus(usd));
    priced.push({ run, cost: { ...cost, costUsd: usd } });
  }

  const runCount = runs.length;
  const pricedRuns = runCount - unavailable;
  const modelTotals = [...perModel.values()];
  const modelAmounts = partitionAmounts(modelTotals.map((entry) => entry.usd), total);
  const wasteTotal = amount(wasted);
  const [operatorCancelledAmount, failedAmount] = partitionAmounts(
    [operatorCancelled, failed],
    wasteTotal,
  );
  const failureEntries = [...failedByClass.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  const failureAmounts = partitionAmounts(
    failureEntries.map(([, entry]) => entry.usd),
    failedAmount ?? ZERO,
  );
  return {
    days,
    since,
    totalUsd: amount(total),
    estimatedUsd: amount(estimated),
    runCount,
    costUnavailableRuns: unavailable,
    avgUsd: amount(pricedRuns === 0 ? ZERO : total.dividedBy(pricedRuns)),
    wastedUsd: wasteTotal,
    waste: {
      totalUsd: wasteTotal,
      operatorCancelledUsd: operatorCancelledAmount ?? ZERO,
      failedUsd: failedAmount ?? ZERO,
      byFailureClass: failureEntries.map(([failureClass, entry], index) => ({
        failureClass,
        usd: failureAmounts[index] ?? ZERO,
        runs: entry.runs,
      })),
    },
    chains: chainReport(chainData, since, chainData.until),
    daily: [...daily].map(([date, byAgent]) => ({
      date,
      byAgent: Object.fromEntries([...byAgent].map(([agent, usd]) => [agent, amount(usd)])),
    })),
    byAgent: [...perAgent]
      .map(([agentId, agentTotal]) => ({
        agent: agentTotal.agent,
        usd: amount(agentTotal.usd),
        runs: runCountByAgent.get(agentId) ?? 0,
        costUnavailableRuns: agentTotal.costUnavailableRuns,
        avgUsd: amount(agentTotal.pricedRuns === 0 ? ZERO : agentTotal.usd.dividedBy(agentTotal.pricedRuns)),
        cachePct: agentTotal.cacheKnownRuns > 0 && agentTotal.inputTokens > 0
          ? (agentTotal.cachedInputTokens / agentTotal.inputTokens) * 100
          : null,
        cacheUnknownRuns: agentTotal.cacheUnknownRuns,
        uncachedInputTokens: agentTotal.uncachedInputTokens,
        uncachedInputUsd: agentTotal.cacheKnownRuns > 0 && agentTotal.cachePricingKnown
          ? amount(agentTotal.uncachedInputUsd)
          : null,
        wastedUsd: amount(agentTotal.wastedUsd),
      }))
      .sort((left, right) => Number(right.usd) - Number(left.usd) || left.agent.localeCompare(right.agent)),
    byModel: modelTotals
      .map((modelTotal, index) => ({
        model: modelTotal.model,
        usd: modelAmounts[index]!,
        runs: modelTotal.runs,
        costUnavailableRuns: modelTotal.costUnavailableRuns,
      }))
      .sort((left, right) => Number(right.usd) - Number(left.usd) || left.model.localeCompare(right.model)),
    topRuns: priced
      .sort((left, right) => right.cost.costUsd.comparedTo(left.cost.costUsd)
        || right.run.startedAt!.getTime() - left.run.startedAt!.getTime())
      .slice(0, COSTS_TOP_RUNS)
      .map(({ run, cost }) => ({
        runId: run.id,
        taskName: run.task?.name ?? null,
        agent: run.agent.name,
        model: run.model,
        usd: amount(cost.costUsd),
        estimated: cost.estimated,
        startedAt: run.startedAt!,
      })),
  };
};

export const readProjectCosts = async (
  db: PrismaClient,
  projectId: string,
  days: number,
  timeZone: string,
  now: Date = new Date(),
): Promise<CostsResponse> => {
  const since = costsWindowStart(now, days, timeZone);
  const until = costsWindowEnd(now, timeZone);
  // Costs is a bounded report, but a matching Chain is not: its first run can
  // predate the selected window and its last run can be a detached repair. The
  // candidate CTE lets PostgreSQL select only report tasks and complete matching
  // chains; the following activity and run reads stay fixed at one per table.
  return db.$transaction(async (tx) => {
    type RawTask = Omit<CostsTaskRow, "templateStep"> & {
      templateStepName: string | null;
      templateStepOutputKind: string | null;
      repairMarkers: Prisma.JsonValue;
    };
    const rawTaskRows = await tx.$queryRaw<RawTask[]>(Prisma.sql`
      WITH candidate_chains AS (
        SELECT DISTINCT primary_task."chainId"
        FROM "Task" AS primary_task
        JOIN "Run" AS chain_run ON chain_run."taskId" = primary_task."id"
        WHERE primary_task."projectId" = ${projectId}
          AND primary_task."chainId" IS NOT NULL
          AND chain_run."endedAt" >= ${since}
          AND chain_run."endedAt" < ${until}
        UNION
        SELECT DISTINCT regression_task."chainId"
        FROM "TaskActivity" AS marker
        JOIN "Task" AS repair_task ON repair_task."id" = marker."taskId"
        JOIN "Task" AS regression_task ON regression_task."id" = marker."metadata"->>'regressionTaskId'
        JOIN "Run" AS repair_run ON repair_run."taskId" = repair_task."id"
        WHERE repair_task."projectId" = ${projectId}
          AND repair_task."chainId" IS NULL
          AND marker."actorType" = 'control-plane'
          AND marker."metadata"->>'kind' = ${MERGE_TAIL_KIND.repairAttempt}
          AND regression_task."projectId" = repair_task."projectId"
          AND regression_task."chainId" IS NOT NULL
          AND repair_run."endedAt" >= ${since}
          AND repair_run."endedAt" < ${until}
      ), candidate_tasks AS (
        SELECT candidate."id"
        FROM "Task" AS candidate
        WHERE candidate."projectId" = ${projectId}
          AND (
            EXISTS (
              SELECT 1 FROM "Run" AS report_run
              WHERE report_run."taskId" = candidate."id"
                AND report_run."startedAt" >= ${since}
                AND report_run."startedAt" < ${until}
            )
            OR candidate."chainId" IN (SELECT "chainId" FROM candidate_chains)
            OR (
              candidate."chainId" IS NULL
              AND EXISTS (
                SELECT 1
                FROM "TaskActivity" AS repair_marker
                JOIN "Task" AS regression
                  ON regression."id" = repair_marker."metadata"->>'regressionTaskId'
                WHERE repair_marker."taskId" = candidate."id"
                  AND repair_marker."actorType" = 'control-plane'
                  AND repair_marker."metadata"->>'kind' = ${MERGE_TAIL_KIND.repairAttempt}
                  AND regression."projectId" = candidate."projectId"
                  AND regression."chainId" IN (SELECT "chainId" FROM candidate_chains)
              )
            )
          )
      )
      SELECT task."id", task."projectId", task."name", UPPER(task."status"::text) AS "status",
        task."chainId", task."chainIndex", task."chainLayer",
        step."name" AS "templateStepName",
        step."outputKind" AS "templateStepOutputKind",
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object('taskId', activity."taskId", 'metadata', activity."metadata")
            ORDER BY activity."createdAt" DESC, activity."id" DESC
          )
          FROM "TaskActivity" AS activity
          WHERE activity."taskId" = task."id"
            AND activity."actorType" = 'control-plane'
            AND activity."metadata"->>'kind' = ${MERGE_TAIL_KIND.repairAttempt}
        ), '[]'::jsonb) AS "repairMarkers"
      FROM "Task" AS task
      JOIN candidate_tasks ON candidate_tasks."id" = task."id"
      LEFT JOIN "TaskTemplateStep" AS step ON step."id" = task."templateStepId"
      ORDER BY task."chainId" ASC NULLS LAST, task."chainLayer" ASC NULLS LAST,
        task."chainIndex" ASC NULLS LAST, task."id" ASC
    `);
    const taskRows: CostsTaskRow[] = rawTaskRows.map((task) => ({
      id: task.id,
      projectId: task.projectId,
      name: task.name,
      status: task.status,
      chainId: task.chainId,
      chainIndex: task.chainIndex,
      chainLayer: task.chainLayer,
      templateStep: task.templateStepName === null || task.templateStepOutputKind === null
        ? null
        : { name: task.templateStepName, outputKind: task.templateStepOutputKind },
    }));
    const activityRows: RepairMarkerRow[] = rawTaskRows.flatMap((task) => (
      Array.isArray(task.repairMarkers)
        ? task.repairMarkers.flatMap((value) => {
            if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
            const row = value as { taskId?: unknown; metadata?: Prisma.JsonValue };
            return typeof row.taskId === "string" && row.metadata !== undefined
              ? [{ taskId: row.taskId, metadata: row.metadata }]
              : [];
          })
        : []
    ));
    const tasks = bindRepairTasks(taskRows, activityRows);
    const chainMemberIds = tasks
      .filter((task) => task.chainId !== null || task.repairChainId !== undefined)
      .map((task) => task.id);
    const allRuns = await tx.run.findMany({
      where: {
        projectId,
        OR: [
          { status: { in: [...terminalRunStatuses] }, startedAt: { gte: since, lt: until } },
          { taskId: { in: chainMemberIds } },
        ],
      },
      select: {
        id: true,
        taskId: true,
        model: true,
        status: true,
        subagentModel: true,
        cancelRequestId: true,
        failureClass: true,
        startedAt: true,
        endedAt: true,
        agent: { select: { id: true, name: true } },
        session: {
          select: {
            nativeChildUsed: true,
            costUsd: true,
            inputTokens: true,
            cachedInputTokens: true,
            cacheCreationInputTokens: true,
            outputTokens: true,
          },
        },
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    });
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const runs = allRuns.map((run) => ({
      ...run,
      task: taskById.get(run.taskId ?? "") ?? null,
    })) as unknown as CostsRunRow[];
    const reportRuns = runs.filter((run) => isTerminalRunStatus(run.status)
      && run.startedAt !== null
      && run.startedAt >= since
      && run.startedAt < until);
    return aggregateCosts(
      reportRuns,
      since,
      days,
      timeZone,
      { tasks, runs, until },
    );
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
};
