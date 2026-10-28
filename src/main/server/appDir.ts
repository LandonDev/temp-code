/** The app's own folder in every project (threads, attachments, plans,
 *  reports, agents' scratch output). Never a user's change: the file tree
 *  hides it, the watcher ignores it, and every git listing and
 *  whole-checkout action behind the Changes section leaves it out. */
export const APP_DIR = '.temp-code'

/** Excludes the folder at any depth, from the repository's top, whatever
 *  the project cwd below it. Pathspec magic: a git call that carries it
 *  must not run under GIT_LITERAL_PATHSPECS (gitops.ts `run`). */
export const APP_DIR_PATHSPEC = `:(top,exclude,glob)**/${APP_DIR}/**`
