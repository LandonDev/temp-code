const handlers = Object.fromEntries(
  ["onSearch", "onReplace", "onToggle", "onToggleReplace", "onPrev", "onNext", "onClose", "onReplaceNext", "onReplaceAll", "onKeyDown", "onCompositionStart", "onCompositionEnd"].map((name) => [name, "fn"]),
);
const base = { ...handlers, searchRef: { current: null }, replaceRef: { current: null }, search: "useEffect", replace: "", caseSensitive: false, wholeWord: false, regexp: false, replaceVisible: false };
export default [
  { name: "matches", props: { ...base, caseSensitive: true, count: { text: "2 of 7", state: "ok" } } },
  { name: "replace open, no results", props: { ...base, search: "useEfect", replaceVisible: true, replace: "useLayoutEffect", count: { text: "No results", state: "empty" } } },
  { name: "invalid regex", props: { ...base, search: "foo(", regexp: true, count: { text: "Invalid regex", state: "invalid" } } },
];
