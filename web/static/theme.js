// Applied before first paint so a saved theme never flashes. External file: the CSP forbids inline scripts.
(function () {
  try { var t = localStorage.getItem('oua-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (e) {}
})();
