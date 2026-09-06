// Runs before the bundle: early theme + glass classes so the first paint
// matches the saved appearance. Externalized (was inline in the donor's
// index.html) so the CSP can stay `script-src 'self'`.
(function () {
  try {
    var root = document.documentElement;
    var hue = localStorage.getItem("monocode.themeHue");
    var sat = localStorage.getItem("monocode.themeSaturation");
    var opacity = localStorage.getItem("monocode.sidebarOpacity");
    if (hue != null) {
      var h = Math.max(0, Math.min(360, Number(hue) || 0));
      root.style.setProperty("--theme-hue", String(h));
    }
    if (sat != null) {
      var s = Math.max(0, Math.min(100, Number(sat) || 0));
      root.style.setProperty("--theme-saturation", s + "%");
    }
    if (opacity != null) {
      var o = Math.max(0.15, Math.min(1, Number(opacity) || 0.85));
      root.style.setProperty("--sidebar-opacity", String(o));
    }
    var scheme = localStorage.getItem("monocode.colorScheme");
    if (scheme === "system") {
      scheme = window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
    }
    if (scheme === "light") {
      root.classList.add("theme-light");
    }
    var bodyGlass = localStorage.getItem("monocode.bodyGlass");
    if (bodyGlass == null || bodyGlass === "1" || bodyGlass === "true") {
      root.classList.add("glass-body");
    }
    var isMac =
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad/.test(navigator.platform);
    if (isMac) {
      root.classList.add("is-mac");
    }
  } catch (_) {}
})();
