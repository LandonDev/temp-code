import { describe, expect, it, vi } from "vitest";
import { settleDiskRace, writeUnlessRaced } from "./diskRace";

const lines = (n: number, trailing = true) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + (trailing ? "\n" : "");
const edit = (text: string, line: number, to: string) => {
  const parts = text.split("\n");
  parts[line - 1] = to;
  return parts.join("\n");
};

describe("settleDiskRace", () => {
  const base = lines(10);

  it("answers the one-sided cases", () => {
    const mine = edit(base, 2, "mine");
    expect(settleDiskRace(base, mine, base)).toEqual({ kind: "ours" });
    expect(settleDiskRace(base, base, mine)).toEqual({ kind: "theirs" });
    expect(settleDiskRace(base, mine, mine)).toEqual({ kind: "same" });
    expect(settleDiskRace(base, base, base)).toEqual({ kind: "same" });
  });

  it("merges edits on lines apart, in either order of position", () => {
    const want = edit(edit(base, 2, "mine"), 9, "theirs");
    expect(settleDiskRace(base, edit(base, 2, "mine"), edit(base, 9, "theirs"))).toEqual({ kind: "merged", text: want });
    const flipped = edit(edit(base, 9, "mine"), 2, "theirs");
    expect(settleDiskRace(base, edit(base, 9, "mine"), edit(base, 2, "theirs"))).toEqual({ kind: "merged", text: flipped });
  });

  it("merges an insertion at the end against an edit at the top", () => {
    const mine = edit(base, 1, "top");
    const theirs = base + "appended\n";
    expect(settleDiskRace(base, mine, theirs)).toEqual({ kind: "merged", text: mine + "appended\n" });
  });

  it("merges in a file without a trailing newline", () => {
    const bare = lines(5, false);
    const mine = edit(bare, 1, "mine");
    const theirs = bare + " more";
    expect(settleDiskRace(bare, mine, theirs)).toEqual({ kind: "merged", text: mine + " more" });
  });

  it("conflicts on the same line", () => {
    expect(settleDiskRace(base, edit(base, 4, "mine"), edit(base, 4, "theirs"))).toEqual({ kind: "conflict" });
  });

  it("conflicts on neighbouring lines", () => {
    expect(settleDiskRace(base, edit(base, 4, "mine"), edit(base, 5, "theirs"))).toEqual({ kind: "conflict" });
    expect(settleDiskRace(base, edit(base, 5, "mine"), edit(base, 4, "theirs"))).toEqual({ kind: "conflict" });
  });

  it("conflicts when one side deletes a range the other edits inside", () => {
    const parts = base.split("\n");
    const deleted = [...parts.slice(0, 2), ...parts.slice(6)].join("\n");
    expect(settleDiskRace(base, edit(base, 4, "mine"), deleted)).toEqual({ kind: "conflict" });
  });
});

describe("writeUnlessRaced", () => {
  const base = lines(10);
  const io = (disk: string | Error) => ({
    read: vi.fn(async () => {
      if (disk instanceof Error) throw disk;
      return disk;
    }),
    write: vi.fn(async (_text: string) => {}),
  });

  it("writes mine when the disk is unchanged", async () => {
    const fake = io(base);
    const mine = edit(base, 2, "mine");
    expect(await writeUnlessRaced(fake, base, mine)).toEqual({ kind: "written", text: mine, merged: false });
    expect(fake.write).toHaveBeenCalledWith(mine);
  });

  it("writes the merged text and says so", async () => {
    const fake = io(edit(base, 9, "theirs"));
    const res = await writeUnlessRaced(fake, base, edit(base, 2, "mine"));
    const want = edit(edit(base, 2, "mine"), 9, "theirs");
    expect(res).toEqual({ kind: "written", text: want, merged: true });
    expect(fake.write).toHaveBeenCalledWith(want);
  });

  it("writes nothing when the disk already holds the buffer, or the buffer is unchanged", async () => {
    const mine = edit(base, 2, "mine");
    const same = io(mine);
    expect(await writeUnlessRaced(same, base, mine)).toEqual({ kind: "current", text: mine });
    const taken = io(mine);
    expect(await writeUnlessRaced(taken, base, base)).toEqual({ kind: "current", text: mine });
    expect(same.write).not.toHaveBeenCalled();
    expect(taken.write).not.toHaveBeenCalled();
  });

  it("writes nothing on a conflict and hands back the disk's text", async () => {
    const theirs = edit(base, 4, "theirs");
    const fake = io(theirs);
    expect(await writeUnlessRaced(fake, base, edit(base, 4, "mine"))).toEqual({ kind: "conflict", theirs });
    expect(fake.write).not.toHaveBeenCalled();
  });

  it("writes mine when the read fails", async () => {
    const fake = io(new Error("ENOENT"));
    const mine = edit(base, 2, "mine");
    expect(await writeUnlessRaced(fake, base, mine)).toEqual({ kind: "written", text: mine, merged: false });
    expect(fake.write).toHaveBeenCalledWith(mine);
  });

  it("rejects when the write fails", async () => {
    const fake = io(base);
    fake.write.mockRejectedValueOnce(new Error("EACCES"));
    await expect(writeUnlessRaced(fake, base, edit(base, 2, "mine"))).rejects.toThrow("EACCES");
  });
});
