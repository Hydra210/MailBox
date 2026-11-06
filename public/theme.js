// Applies the saved theme before first paint so the page never flashes the wrong colors.
(function () {
  var theme = "dark";
  try { if (localStorage.getItem("mailbox-theme") === "light") theme = "light"; } catch (e) {}
  document.documentElement.setAttribute("data-theme", theme);
  var meta = document.getElementById("theme-color");
  if (meta) meta.setAttribute("content", theme === "light" ? "#f3f4f7" : "#0b0c0f");
})();
