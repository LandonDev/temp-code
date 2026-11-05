import { SurfaceSkeleton } from "../SurfaceSkeleton";

/** BoardFailed: the master's chat (a still transcript skeleton stands in) under the line and Retry. */
export default [
  {
    name: "the board failed",
    props: { renderChat: () => <div className="min-h-0 flex-1"><SurfaceSkeleton kind="transcript" label="Loading thread" /></div>, onRetry: () => {} },
  },
];
