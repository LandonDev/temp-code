import { Fragment, useMemo, useState } from "react";
import { PageRow, PageSection } from "../../components/page";
import { Input } from "../../components/ui/input";
import { filterKeybindings, KEYBINDING_GROUPS, KEYBINDING_SCOPE_LABEL } from "../../lib/settings";
import { Keys } from "./keys";

export function KeybindingsPage() {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => filterKeybindings(KEYBINDING_GROUPS, query), [query]);

  return (
    <>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter"
        aria-label="Filter keybindings"
        spellCheck={false}
        autoComplete="off"
      />
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">No shortcut matches</p>
      ) : (
        groups.map((group) => (
          <PageSection key={group.title} title={group.title}>
            {group.bindings.map((binding) => (
              <PageRow
                key={binding.name}
                title={binding.name}
                description={binding.scope ? KEYBINDING_SCOPE_LABEL[binding.scope] : undefined}
              >
                {binding.keys.map((chord, index) => (
                  <Fragment key={chord.join("")}>
                    {index > 0 ? <span className="text-xs text-muted-foreground">or</span> : null}
                    <Keys keys={chord} className="" />
                  </Fragment>
                ))}
              </PageRow>
            ))}
          </PageSection>
        ))
      )}
    </>
  );
}
