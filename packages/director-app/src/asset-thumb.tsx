// [U14] The thumbnail an Asset node shows once its Calliope row has an image.
//
// A separate file so `nodes.tsx` imports ONE small component rather than the Assets panel
// (which registers a tab as a side effect of being imported). Resolves the file path to a
// URL through the context's client; outside a provider (graph tests) it renders nothing.

import { useContext, useEffect, useState } from "react";
import { DirectorContext } from "./director-context.js";
import "./styles/u14-assets.css";

export function AssetThumb({ path }: { path: string }) {
  const ctx = useContext(DirectorContext);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [path]);
  if (!ctx || broken) return null;
  return <img className="bd-asset-thumb nodrag" src={ctx.client.fileUrl(path)} alt="" draggable={false} loading="lazy" onError={() => setBroken(true)} />;
}
