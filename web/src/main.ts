// Widget entry point. The main loop (fix -> reachability -> ranking -> render)
// lands here; for now it only proves the page boots.
const app = document.getElementById("app");
if (app) {
  app.textContent = "hello world";
}

export {};
