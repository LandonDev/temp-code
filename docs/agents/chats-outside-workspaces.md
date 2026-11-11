# Chats outside every workspace stay there

- A thread with neither a project nor a workspace is the home's, whatever
  its cwd, on the Mac or the box: the renderer places it by its ids
  (`workspacePathOfSession` answers "~"; only a path-only row from before ids
  whose cwd is a workspace's folder still sits in that workspace).
- `session.create { workspaceId: null }` creates a thread outside every
  workspace and the host never fills it from the cwd; an omitted
  `workspaceId` (an older or path-only caller) still takes the workspace
  whose folder is the cwd. A workspace made later claims no existing thread.
  The renderer's `ensureCreated` always sends the draft's own workspace,
  null for a home draft (lib/tcserver/commands.ts).
- A home draft runs at "~": `sessionFromDraft` puts a home record saved with
  a folder back at the home, and `newBootSeed` seeds the home when the
  window's last folder is no workspace the catalog knows. Showing a home
  thread moves the window to the home (`project.followSession`, from tab
  activation and opening a thread), so New chat never drafts in the
  window's last folder. The draft host picker moves a home draft to another
  host's home. The phone always names a workspace when it creates a thread.
