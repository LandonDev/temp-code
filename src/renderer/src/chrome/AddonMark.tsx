import { brandOf } from "../lib/addonBrand";
import type { SlashCommand } from "../lib/tcserver/types";
import { Blocks, Plug, SlashSquare, Terminal } from "./icons";

/** A command's mark: the brand for a known product, else its source glyph. */
export function AddonMark({
  command,
  size = 14,
  colored = true,
  className = "",
}: {
  command: Pick<SlashCommand, "name" | "source">;
  size?: number;
  /** Brand color for menus; monochrome (currentColor) inside chips. */
  colored?: boolean;
  className?: string;
}) {
  const brand = brandOf(command.name);
  if (brand) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className={`shrink-0 ${className}`}
        aria-hidden
      >
        <path d={brand.path} fill={colored ? `#${brand.hex}` : "currentColor"} />
      </svg>
    );
  }
  const cls = `shrink-0 text-content/55 ${className}`;
  const px = { width: size, height: size };
  switch (command.source) {
    case "plugin":
      return <Blocks style={px} className={cls} />;
    case "mcp":
      return <Plug style={px} className={cls} />;
    case "prompt":
      return <Terminal style={px} className={cls} />;
    default:
      return <SlashSquare style={px} className={cls} />;
  }
}
