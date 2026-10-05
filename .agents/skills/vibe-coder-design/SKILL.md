---
name: vibe-coder-design
description: "High-taste, GPU-composited frontend design system playbook. Enforces 60 FPS compositor invariants, Tailwind CSS v4 tokens, gapless bento grids, and eliminates thermal throttling traps."
tags: [frontend, design-system, tailwind, gpu-compositor, bento-grid, 60fps]
created: "2026-10-01 15:10:00"
---

# vibe-coder-design

A production-grade senior frontend engineering playbook for modern, high-taste AI applications.

## The Problem Addressed
Social media hype promotes unvetted "vibe coder" CSS snippets featuring heavy full-screen gradient drift and high-radius blur layers. On real hardware, these trigger full-viewport CPU/GPU repaints every 16ms, dropping frame rates from 60 FPS to 15 FPS and causing thermal throttling.

`vibe-coder-design` enforces strict physical invariants while delivering top-tier modern visual aesthetics.

---

## 1. The Inviolable GPU Compositor Invariants (Permanent Rule #4)

1. **Only Animate Composited Properties**:
   - **PERMITTED**: `transform` (translate, scale, rotate) and `opacity`. These are handled directly on the GPU compositor thread without triggering layout or paint cycles.
   - **FORBIDDEN IN INFINITE LOOPS**: Never animate `background-position`, `box-shadow`, `width`/`height`, or `filter: blur()`.
2. **Blur Radius Budget**:
   - `backdrop-filter: blur(...)` must be strictly $\le 16\text{px}$. Higher radii exponentially increase fill-rate cost.
3. **Layer Isolation**:
   - Use `will-change: transform` or `transform: translateZ(0)` sparingly and strictly on animated elements to isolate paint surfaces.

---

## 2. Dark-First Design Tokens (Tailwind CSS v4)

```css
@theme {
  --color-canvas: #09090b;
  --color-surface: #121215;
  --color-surface-hover: #18181b;
  --color-border-subtle: rgba(255, 255, 255, 0.08);
  --color-border-hover: rgba(255, 255, 255, 0.16);
  --color-accent: #3b82f6;
  --color-text-primary: #f4f4f5;
  --color-text-muted: #a1a1aa;
  
  --radius-bento: 12px;
}
```

---

## 3. Gapless Bento Grid Architecture

Bento grids must be gapless or micro-gapped (1px border separation) to prevent visual noise while avoiding layout thrashing:

```html
<div class="grid grid-cols-1 md:grid-cols-12 gap-px bg-white/10 rounded-xl overflow-hidden border border-white/10">
  <!-- Large Hero Card (8 cols) -->
  <div class="col-span-1 md:col-span-8 bg-[#121215] p-6 hover:bg-[#18181b] transition-colors duration-200">
    <h3 class="text-lg font-medium text-zinc-100">Deterministic Engine</h3>
    <p class="text-sm text-zinc-400 mt-2">Zero hallucinations, verified execution gate.</p>
  </div>

  <!-- Metric Card (4 cols) -->
  <div class="col-span-1 md:col-span-4 bg-[#121215] p-6 hover:bg-[#18181b] transition-colors duration-200">
    <div class="text-3xl font-mono text-zinc-100">0.02ms</div>
    <div class="text-xs text-zinc-500 uppercase tracking-wider mt-1">Per-Token Latency</div>
  </div>
</div>
```

---

## 4. DOM Overload Discipline (Permanent Rule #5)

- Never inject 100+ rich DOM cards into a single unpaginated scroll container.
- Always paginate in chunks of **15–25 items** or use virtualized windowing (`react-virtual` or native IntersectionObserver chunk loading).
