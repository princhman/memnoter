// Both native web surfaces follow the effective WebKit appearance, including live changes.
const theme = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => {
  document.documentElement.classList.toggle("dark", theme.matches);
  document.documentElement.style.colorScheme = theme.matches ? "dark" : "light";
};
theme.addEventListener("change", applyTheme);
applyTheme();

