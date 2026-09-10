import { useEffect, useState } from 'react';
import GradientWaves from './GradientWaves.jsx';

/*
 * THE APPLICATION'S BACKGROUND LAYER. One instance, every route.
 *
 * Mounted once in the app shell rather than per page, which is what makes the
 * background CONSTANT while navigating: the WebGL context is created a single
 * time and is never torn down by a route change, so the waves keep moving
 * across Agent -> Incidents -> Catalog instead of restarting on each one.
 * A per-page instance would also mean N live WebGL contexts, which browsers
 * cap and then start dropping.
 *
 * GradientWaves.jsx is React Bits' own source, vendored verbatim — nothing in
 * it is edited. Everything NowHelpAssist-specific lives here: the palette, the
 * restraint, and the one accessibility decision the vendor file leaves to its
 * caller.
 *
 * PALETTE — three tokens, no new colours. The horizon is --ink, so the far
 * distance dissolves into the same ground the rest of the app is painted on
 * and the playground has no visible seam; the body and crest are the two
 * verdigris tokens, which is the accent this app already reserves for "the
 * agent is working". Brightness and opacity are held well below the React Bits
 * defaults because a transcript is read on top of this: the bubbles, tool
 * cards and the amber approval gate are all opaque, but the muted metadata
 * beneath them is not, and that is the text this had to stay clear of.
 *
 * MOTION — a full-area animated field is exactly what `prefers-reduced-motion`
 * is for. The global `* { animation: none }` rule in styles.css cannot reach
 * this: the waves are driven by requestAnimationFrame inside a WebGL canvas,
 * not by CSS. So the query is read here and the speed is set to zero, which
 * leaves the same still image rather than removing the background entirely.
 *
 * POINTER — mouseInteraction is off deliberately, and the wrapper is
 * pointer-events: none. The layer sits under a transcript, an input and an
 * approval gate; it must never be the thing that receives a click. Leaving the
 * parallax on would have been dead code anyway — its listeners sit on a canvas
 * that no pointer event can reach.
 */
export default function PlaygroundBackground() {
  const [stillness, setStillness] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const read = () => setStillness(mq.matches);
    read();
    mq.addEventListener('change', read);
    return () => mq.removeEventListener('change', read);
  }, []);

  return (
    <div className="app-bg" aria-hidden="true">
      <GradientWaves
        horizonColor="#0e1116"
        waveColor="#1c3729"
        crestColor="#4a9268"
        speed={stillness ? 0 : 0.22}
        amplitude={2.4}
        waveScale={0.55}
        tilt={1.02}
        height={6.0}
        fogDepth={28}
        brightness={0.72}
        opacity={0.55}
        grain
        grainIntensity={0.03}
        mouseInteraction={false}
      />
    </div>
  );
}
