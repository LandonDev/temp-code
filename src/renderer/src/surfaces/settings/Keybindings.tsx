import { Fragment, useMemo, useState } from "react";
import { PageRow, PageSection } from "../../components/page";
import { Empty, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
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
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No shortcut matches</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="@container">
          <div className="grid grid-cols-1 gap-6 @min-[560px]:grid-cols-2 @min-[560px]:gap-x-8">
            {groups.map((group) => (
              <PageSection key={group.title} title={group.title}>
                {group.bindings.map((binding) => (
                  <PageRow
                    key={binding.name}
                    className="min-h-8 py-1.5"
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
            ))}
          </div>
        </div>
      )}
    </>
  );
}
