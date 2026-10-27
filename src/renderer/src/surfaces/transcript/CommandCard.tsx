// A8 (action rows): the body a command row opens onto.
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { shellTokens, type ShellTone } from "../../lib/shellTokens";
import type { Block } from "../../lib/session";
import { invocationBody, isSettled, rawInput, toolOutput } from "../../lib/toolDetails";
import { humanName } from "../../lib/toolPhrase";
import { InvocationBlock, OmittedNote, ToolOutputLines, useRowBodies } from "../ToolDetails";

const TONE: Record<ShellTone, string> = {
  command: "text-info",
  string: "text-success",
  operator: "text-muted-foreground",
  flag: "text-foreground/70",
  text: "text-foreground",
};

/** Lines of a command shown before "Show all". */
export const COMMAND_LINE_CAP = 12;

/**
 * The tool's name, the command in mono with a light tint, then what it
 * printed. Nothing while it runs: live output is the right panel's.
 */
export function CommandCard({ block, failed }: { block: Block; failed: boolean }) {
  const omitted = useRowBodies(block);
  const [all, setAll] = useState(false);
  const command = invocationBody(block) || rawInput(block);
  const lines = command.split("\n");
  const capped = !all && lines.length > COMMAND_LINE_CAP;
  const shown = capped ? lines.slice(0, COMMAND_LINE_CAP).join("\n") : command;
  const out = toolOutput(block);
  const name = humanName(block.tool?.name || "Shell");
  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-1 text-xs text-muted-foreground">{name}</div>
      <InvocationBlock>
        <span className="text-muted-foreground">$ </span>
        {shellTokens(shown).map((token, i) => (
          <span key={i} className={TONE[token.tone]}>
            {token.text}
          </span>
        ))}
      </InvocationBlock>
      {capped ? (
        <Button variant="link" size="xs" className="self-start px-0 text-muted-foreground" onClick={() => setAll(true)}>
          Show all
        </Button>
      ) : null}
      {omitted ? (
        <OmittedNote bytes={omitted.bytes} failed={!!omitted.failed} />
      ) : out ? (
        <ToolOutputLines text={out.text} error={failed || out.error} />
      ) : isSettled(block) ? (
        <ToolOutputLines text="" error={failed} />
      ) : null}
    </div>
  );
}
