import { type ReactNode, useState } from "react";

import { errorMessage } from "../lib/api";
import { usePoll } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { useProjectScope } from "../lib/project";
import { navigate } from "../lib/router";
import type { Agent, Repo } from "../lib/types";
import { IconPlus } from "./icons";
import { NewTask } from "./new-task-panel";
import {
  ErrorNotice, FullPanel, PAGE_ACTIONS, PAGE_HEAD, PAGE_HEAD_H1, PAGE_HEAD_SUBTITLE, PAGE_HEAD_TITLES, Segmented,
} from "./ui";
import { Button } from "./ui/button";

export type TasksTab = "tasks" | "automations" | "triggers" | "archived";

const TAB_KEYS: Array<{ value: TasksTab; labelKey: string }> = [
  { value: "tasks", labelKey: "tasks.tab.tasks" },
  { value: "automations", labelKey: "tasks.tab.automations" },
  { value: "triggers", labelKey: "tasks.tab.triggers" },
  { value: "archived", labelKey: "tasks.tab.archived" },
];

/**
 * The head shared by all four Tasks routes: title, `+ Create Task`, and the tab
 * strip.
 *
 * It owns the creation panel outright — the button is rendered on every tab, so
 * exactly one component may hold `creating`, and it is this one. `onCreated` is
 * optional because a task made from the Triggers tab has nowhere to appear
 * there; the board passes its `reload`, the other three pass nothing.
 */
export const TasksPageHead = ({ active, onCreated }: {
  active: TasksTab;
  onCreated?: () => void;
}): ReactNode => {
  const { projectId, project } = useProjectScope();
  const [creating, setCreating] = useState(false);
  // These options belong to the creation form, not the board's first load.
  const agents = usePoll<Agent[]>(!creating || projectId === "" ? null : `/projects/${projectId}/agents`, 15_000);
  const repos = usePoll<Repo[]>(!creating || projectId === "" ? null : `/projects/${projectId}/repos`, 15_000);
  const t = useT();
  const tabs = TAB_KEYS.map((tab) => ({ value: tab.value, label: t(tab.labelKey) }));

  return (
    <>
      <div className={PAGE_HEAD}>
        <div className={PAGE_HEAD_TITLES}>
          <h1 className={PAGE_HEAD_H1}>{t("tasks.head.title")}</h1>
          <div className={PAGE_HEAD_SUBTITLE}>{t("tasks.head.subtitle", { project: project?.name ?? t("tasks.head.thisProject") })}</div>
        </div>
        <div className={PAGE_ACTIONS}>
          <Button type="button" variant="legacyPrimary" size="legacy" onClick={() => setCreating(true)}><IconPlus />{t("tasks.create")}</Button>
        </div>
      </div>

      <Segmented options={tabs} value={active} onChange={(value) => navigate(`/${value}`)} />

      {creating && projectId !== "" ? (
        agents.data === null || repos.data === null ? (
          <FullPanel title={t("newTask.title")} onClose={() => setCreating(false)}>
            {agents.error === null ? null : <ErrorNotice message={errorMessage(agents.error)} onRetry={agents.reload} />}
            {repos.error === null ? null : <ErrorNotice message={errorMessage(repos.error)} onRetry={repos.reload} />}
            {agents.error === null && repos.error === null ? <p role="status">{t("common.loading")}</p> : null}
          </FullPanel>
        ) : (
          <NewTask key={projectId} projectId={projectId} project={project} agents={agents.data} repos={repos.data}
            onClose={() => setCreating(false)} onCreated={() => onCreated?.()} />
        )
      ) : null}
    </>
  );
};
