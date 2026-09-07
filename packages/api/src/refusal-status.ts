/**
 * The HTTP status family a refusal is answered with.
 *
 * Declared on its own so that every module declaring refusal codes states the
 * family beside the code, without depending on the module that renders the
 * response.
 */
export type RefusalStatus = 400 | 403 | 404 | 409 | 413 | 422;
