// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AdmissionState } from "@server/shared/contract-admission";

/**
 * Settings → Remote access → Running threads: a row per connected host
 * with its running count of the cap, the queue, the memory line, the cap
 * field and Use default; a spinner while admission.get answers; no row for
 * a host that does not answer it.
 */

const state = (over: Partial<AdmissionState> = {}): AdmissionState => ({
  cap: 120,
  pinned: null,
  default: 120,
  running: 118,
  queued: 7,
  memory: { budgetMB: 81920, reserveMB: 20480, perProcessMB: 331, freeMB: 9216, floorMB: 8192 },
  ...over,
});

const answers = new Map<string, () => Promise<AdmissionState>>();
const requests: { env: string; method: string; params: unknown }[] = [];
let caps: string[] = ["read", "operate", "approve", "admin"];

vi.mock("../lib/connection", () => ({
  useEnvironments: () => [
    { id: "local", name: "This Mac", routes: [], credentialRef: null },
    { id: "env_box", name: "The box", routes: [], credentialRef: null },
  ],
  useEnvironmentStatus: () => ({ transport: "open", lastHello: { caps } }),
  registry: {
    link: (env: string) => ({
      request: (method: string, params: unknown) => {
        requests.push({ env, method, params });
        const answer = answers.get(`${env}:${method}`);
        return answer ? answer() : Promise.reject(new Error("unknown method"));
      },
    }),
  },
}));

const { AdmissionSettings, gib } = await import("./AdmissionSettings");

afterEach(() => {
  cleanup();
  answers.clear();
  requests.length = 0;
  caps = ["read", "operate", "approve", "admin"];
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

describe("AdmissionSettings", () => {
  it("shows a spinner while admission.get answers, then the running line and the memory line", async () => {
    let resolve!: (s: AdmissionState) => void;
    answers.set("local:admission.get", () => new Promise((r) => (resolve = r)));
    const { container } = render(<AdmissionSettings />);
    expect(screen.getByText("Running threads")).toBeTruthy();
    expect(screen.getByText("This Mac")).toBeTruthy();
    expect(container.querySelector("[aria-label='Running cap']")).toBeNull();
    await act(async () => resolve(state()));
    expect(screen.getByText("Running 118 of 120 · 7 queued")).toBeTruthy();
    expect(screen.getByText("80 GiB budget · 331 MB per thread · 9 GiB free")).toBeTruthy();
    // On the default: the field shows it as its placeholder, and there is nothing to go back to.
    const field = screen.getByLabelText("Running cap") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("120");
    expect(screen.queryByText("Use default")).toBeNull();
  });

  it("a host that does not answer admission.get has no row", async () => {
    answers.set("local:admission.get", async () => state({ queued: 0 }));
    render(<AdmissionSettings />);
    await flush();
    expect(screen.getByText("Running 118 of 120")).toBeTruthy();
    expect(screen.queryByText("The box")).toBeNull();
  });

  it("pins the cap from the field, and Use default goes back", async () => {
    answers.set("local:admission.get", async () => state());
    answers.set("local:admission.set", async () => state({ cap: 60, pinned: 60 }));
    render(<AdmissionSettings />);
    await flush();
    const field = screen.getByLabelText("Running cap") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "60" } });
    fireEvent.blur(field);
    await flush();
    expect(requests.filter((r) => r.method === "admission.set")).toEqual([{ env: "local", method: "admission.set", params: { cap: 60 } }]);
    expect(screen.getByText("Running 118 of 60 · 7 queued")).toBeTruthy();
    expect((screen.getByLabelText("Running cap") as HTMLInputElement).value).toBe("60");
    answers.set("local:admission.set", async () => state());
    fireEvent.click(screen.getByText("Use default"));
    await flush();
    expect(requests.filter((r) => r.method === "admission.set").at(-1)?.params).toEqual({ cap: null });
    expect(screen.queryByText("Use default")).toBeNull();
  });

  it("a bad number puts the field back and sends nothing", async () => {
    answers.set("local:admission.get", async () => state());
    render(<AdmissionSettings />);
    await flush();
    const field = screen.getByLabelText("Running cap") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "0" } });
    fireEvent.blur(field);
    expect(field.value).toBe("");
    expect(requests.some((r) => r.method === "admission.set")).toBe(false);
  });

  it("a key without admin reads the cap but cannot change it", async () => {
    caps = ["read", "operate"];
    answers.set("local:admission.get", async () => state({ cap: 60, pinned: 60 }));
    render(<AdmissionSettings />);
    await flush();
    expect((screen.getByLabelText("Running cap") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText("Use default")).toBeNull();
  });

  it("formats GiB the way the line reads", () => {
    expect(gib(81920)).toBe("80 GiB");
    expect(gib(9216)).toBe("9 GiB");
    expect(gib(2560)).toBe("2.5 GiB");
  });
});
