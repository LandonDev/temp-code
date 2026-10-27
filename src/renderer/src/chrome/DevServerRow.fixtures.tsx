const server = {
  key: "env_box/res1",
  environmentId: "env_box",
  title: "Vite dev server",
  sessionId: "t1",
  owner: "Coins page",
  port: { number: 5173, environmentId: "env_box" },
  runId: null,
  resource: { id: "res1", sessionId: "t1" },
  startedAt: 1,
};
export default [
  { name: "a thread's server", props: { server } },
  { name: "a Bun server, picked", props: { server: { ...server, key: "env_box/res2", title: "Bun server", port: { number: 3000, environmentId: "env_box" } }, picked: true, onPick: "fn" } },
  { name: "stopping", props: { server: { ...server, stopping: "" } } },
];
