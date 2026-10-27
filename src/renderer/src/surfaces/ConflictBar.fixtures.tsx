const noop = () => {};

export default [
  { name: "changed on disk", props: { kind: "external", onReload: noop, onKeep: noop } },
  { name: "deleted on disk", props: { kind: "deleted", onReload: noop, onKeep: noop } },
];
