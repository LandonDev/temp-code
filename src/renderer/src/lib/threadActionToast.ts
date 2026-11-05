/** A failed thread action's toast (lib/threadActionFailure.ts), its words
 *  loaded on first use: the first paint never needs them. */
export function actionFailed(verb: string, title: string, err: unknown): void {
  console.warn("[thread-action]", verb, err);
  void import("./threadActionFailure").then((m) => m.toastActionFailed(verb, title, err));
}
