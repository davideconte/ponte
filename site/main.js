// Copy buttons: data-copy holds the text, data-copy-from points to a <pre> whose
// commands are copied without the trailing "# comment" parts.
(function () {
  function textFor(btn) {
    if (btn.dataset.copy) return btn.dataset.copy;
    var el = document.getElementById(btn.dataset.copyFrom);
    if (!el) return "";
    return el.innerText
      .split("\n")
      .map(function (line) { return line.replace(/\s+#.*$/, "").replace(/^#.*$/, ""); })
      .filter(function (line) { return line.trim() !== ""; })
      .join("\n");
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function done(btn, ok) {
    var label = btn.textContent;
    btn.textContent = ok ? "Copied" : "Press Ctrl+C";
    btn.classList.toggle("is-done", ok);
    clearTimeout(btn._t);
    btn._t = setTimeout(function () {
      btn.textContent = "Copy";
      btn.classList.remove("is-done");
    }, 1600);
    return label;
  }

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest(".copy");
    if (!btn) return;
    var text = textFor(btn);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () { done(btn, true); },
        function () { done(btn, fallbackCopy(text)); }
      );
    } else {
      done(btn, fallbackCopy(text));
    }
  });
})();
