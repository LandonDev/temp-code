# The menu bar: one table

src/shared/menuTree.ts is the menu as data, read by main (src/main/menu.ts),
the in-app bar and the tests: TempCode, File, Edit, View (Show/Hide
Message List, ⌘⇧M, folds the transcript's message list in every thread of
the window, lib/messageListFold.ts; Force Reload,
keyless, reloads the focused window past its cache from main), Go
(navigation), Threads (Switch Model, Mark All Read, the fleet switches),
Window and Help (What's New opens the running build's notes, Show Logs opens
`<userData>/logs`, the host profile, Developer Tools). Ids
are command ids of lib/appCommands.ts; `MAIN_MENU_IDS` act in main. Each
window sends what it shows over `menu:state` (lib/nativeMenuState.ts:
Show/Hide on the four toggles, ⌘W's Close Tab or Close Pane while the
focused tab is split, idle rows greyed) and main rebuilds the menu
from the focused window's state when it changes. A `pageKey` row (New
Terminal, ⌃`) shows its key but leaves it to the page. The in-app bar
(chrome/MenuBar.tsx, `inAppMenus`) mounts only in web mode off macOS: a
desktop window off macOS has the native bar. It is a `menubar` named "Menu
bar": a lone Alt focuses its first title, Left, Right, Home and End move
between the titles (one tab stop; while a menu is open Left and Right open
its neighbour), and Escape with no menu open, or Alt again, closes it and
puts the focus back where it was, as a pick does before its command runs. Go to Symbol is ⌘⇧O and
Open Project ⌘O, in the menu and the renderer's resolver alike; New
Terminal is ⌃` (⌘` is macOS's window cycle).
Every Node warning the main process raises lands in its log with the site
that raised it (src/main/warningLog.ts `installWarningLog`, the first thing
index.ts does after its boot mark): Node prints a warning's name and message
alone, so the `MaxListenersExceededWarning` V1 saw at boot named neither its
emitter nor its listener. It was appshots.ts: the preload sends
`appshot-ready` at every registration of a capture listener (each pane,
each remount), and each announcement added a `destroyed` listener to the
window; `appshotReady` watches a window for its end once.
