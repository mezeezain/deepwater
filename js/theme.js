// Applies the saved light/dark choice before first paint (classic script, loaded in <head>).
(function () {
  try {
    var t = localStorage.getItem('dw-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow system */ }
})();
