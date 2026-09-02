// Standalone harness. Lets the editor be developed without a ComfyUI restart loop; the panel
// mounts the very same `mountDirector`, so anything working here works there.
import { mountDirector } from "./index.jsx";

const el = document.getElementById("root");
if (el) {
  const handle = mountDirector(el);
  // The e2e suite drives the editor through the same API the agent uses.
  (window as unknown as { __director: typeof handle }).__director = handle;
}
