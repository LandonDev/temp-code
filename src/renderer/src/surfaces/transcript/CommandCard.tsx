// A8 (action rows): the body a command row opens onto.
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { shellTokens, type ShellTone } from "../../lib/shellTokens";
import type { Block } from "../../lib/session";
import { invocationBody, rawInput, toolOutput } from "../../lib/toolDetails";
import { humanName } from "../../lib/toolPhrase";
import { OmittedNote, ToolOutputLines, useRowBodies } from "../ToolDetails";

/** Ink only: colour in the transcript means a status, so the command has none. */
const TONE: Record<ShellTone, string> = {
  command: "text-foreground",
  string: "text-foreground/70",
  operator: "text-muted-foreground",
  flag: "text-foreground/70",
  text: "text-foreground",
};

/** Lines of a command shown before "Show all". */
export const COMMAND_LINE_CAP = 12;

/**
 * The tool's name, the command in mono with a light tint under it, its `$`
 * in line with the name, then what it printed. Nothing while it runs: live
 * output is the right panel's. The frame around it is the row's body
 * (ActionRow): a card on its own, nothing inside the group's list.
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
      <pre className="min-w-0 font-mono text-[13px] leading-5 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
        <span className="text-muted-foreground">$ </span>
        {shellTokens(shown).map((token, i) => (
          <span key={i} className={TONE[token.tone]}>
            {token.text}
          </span>
        ))}
      </pre>
      {capped ? (
        <Button variant="link" size="xs" className="self-start px-0 text-muted-foreground" onClick={() => setAll(true)}>
          Show all
        </Button>
      ) : null}
      {omitted ? (
        <OmittedNote bytes={omitted.bytes} failed={!!omitted.failed} />
      ) : out ? (
        <ToolOutputLines text={out.text} error={failed || out.error} />
      ) : null}
    </div>
  );
}
