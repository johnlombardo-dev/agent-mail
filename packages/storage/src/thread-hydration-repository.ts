import type { Database } from "bun:sqlite";
import { ThreadCursorCodec } from "./thread-cursor";
import {
  ThreadGraphRepository,
  type ThreadGraphRepositoryOptions,
} from "./thread-graph-repository";
import type { ThreadPage } from "./thread-types";

export type ThreadHydrationRequest = Readonly<{
  readonly accountId: unknown;
  readonly threadId: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
}>;

/** Hydration is a read-only facade over the SQLite thread authority. */
export class ThreadHydrationRepository {
  readonly #graph: ThreadGraphRepository;

  constructor(database: Database, options: ThreadGraphRepositoryOptions = {}) {
    this.#graph = new ThreadGraphRepository(database, options);
  }

  get(request: ThreadHydrationRequest): ThreadPage {
    return this.#graph.getPage(request);
  }

  getPage(request: ThreadHydrationRequest): ThreadPage {
    return this.get(request);
  }
}

export function hydrateThreadPage(
  database: Database,
  request: ThreadHydrationRequest,
  options: ThreadGraphRepositoryOptions = {},
): ThreadPage {
  return new ThreadHydrationRepository(database, options).getPage(request);
}

export const createThreadHydrationRepository = (
  database: Database,
  options: ThreadGraphRepositoryOptions = {},
): ThreadHydrationRepository => new ThreadHydrationRepository(database, options);

export type { ThreadCursorCodec };
