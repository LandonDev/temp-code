// Fixtures for `bun run ui:preview src/renderer/src/surfaces/DevStarter.tsx#DevStarter`.
import type { DevTarget } from "@server/shared/contract-devservers";

const web: DevTarget = { id: "apps/web#dev", name: "web", script: "dev", kind: "web", framework: "vite", dir: "apps/web", command: "bun run dev", macOnly: false, what: "Vite dev server" };
const api: DevTarget = { id: "apps/api#dev", name: "api", script: "dev", kind: "web", framework: null, dir: "apps/api", command: "bun --watch src/server.ts", macOnly: false, what: "Bun server" };
const box = { environmentId: "env_box", name: "box", projectId: "p9" };
const mac = { environmentId: "env_mac", name: "Mac", projectId: "p9m" };
const starter = {
  hosts: [box],
  envId: "env_box",
  pickHost: "fn",
  targets: [web, api],
  target: web,
  pickTarget: "fn",
  starting: false,
  error: null,
  asking: false,
  run: "fn",
  answer: "fn",
};

export default [
  { name: "loading the targets", props: { starter: { ...starter, targets: undefined, target: undefined } } },
  { name: "two targets", props: { starter } },
  { name: "two hosts", props: { starter: { ...starter, hosts: [mac, box] } } },
  { name: "starting", props: { starter: { ...starter, starting: true } } },
  { name: "the thread already runs one", props: { starter: { ...starter, asking: true } } },
  { name: "nothing to serve, and a refusal", props: { starter: { ...starter, targets: [], target: undefined, error: "devServer.start: the host has no copy of this project" } } },
];
