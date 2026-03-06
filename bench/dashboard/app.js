const root = document.getElementById("app");
const snapshot = window.__QUIPBENCH_LATEST__;
const logoImageCache = new Map();

function logoFor(name) {
  if (name.includes("Gemini")) return "./assets/logos/gemini.svg";
  if (name.includes("Kimi")) return "./assets/logos/kimi.svg";
  if (name.includes("DeepSeek")) return "./assets/logos/deepseek.svg";
  if (name.includes("GLM")) return "./assets/logos/glm.svg";
  if (name.includes("GPT")) return "./assets/logos/openai.svg";
  if (name.includes("Opus") || name.includes("Sonnet")) return "./assets/logos/claude.svg";
  if (name.includes("Grok")) return "./assets/logos/grok.svg";
  if (name.includes("MiniMax")) return "./assets/logos/minimax.svg";
  return null;
}

function formatDate(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}

function rowHtml(row) {
  const logo = logoFor(row.modelName);
  return `
    <tr>
      <td class="mono rank">${row.rank}</td>
      <td>
        <div class="model-cell">
          ${logo ? `<img src="${logo}" alt="" />` : ""}
          <span>${row.modelName}</span>
        </div>
      </td>
      <td class="mono">${row.elo.toFixed(2)}</td>
      <td class="mono">${row.wins}</td>
      <td class="mono">${row.games}</td>
      <td class="mono">${row.winRate.toFixed(2)}%</td>
    </tr>
  `;
}

function renderChart(rows) {
  const chartCanvas = document.getElementById("elo-chart");
  if (!chartCanvas || typeof Chart === "undefined" || rows.length === 0) return;

  const sorted = [...rows].sort((a, b) => b.elo - a.elo);
  const labels = sorted.map((row) => row.modelName);
  const data = sorted.map((row) => Number(row.elo.toFixed(2)));
  const max = Math.max(...data);
  const min = Math.min(...data);
  const yMin = Math.floor(min - 20);
  const yMax = Math.ceil(max + 10);

  const iconPlugin = {
    id: "barIcons",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      const topY = chart.scales.y.getPixelForValue(yMax);

      meta.data.forEach((bar, index) => {
        const modelName = labels[index];
        const iconUrl = logoFor(modelName);
        if (!iconUrl) return;

        let img = logoImageCache.get(iconUrl);
        if (!img) {
          img = new Image();
          img.src = iconUrl;
          img.onload = () => chart.draw();
          logoImageCache.set(iconUrl, img);
        }
        if (!img.complete || !img.naturalWidth) return;

        const iconSize = 18;
        const x = bar.x - iconSize / 2;
        const y = Math.max(topY + 4, bar.y - iconSize - 6);

        ctx.save();
        ctx.fillStyle = "#0a0a0a";
        ctx.strokeStyle = "#2a2a2a";
        ctx.lineWidth = 1;
        if (typeof ctx.roundRect === "function") {
          ctx.beginPath();
          ctx.roundRect(x - 3, y - 3, iconSize + 6, iconSize + 6, 6);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(x - 3, y - 3, iconSize + 6, iconSize + 6);
          ctx.strokeRect(x - 3, y - 3, iconSize + 6, iconSize + 6);
        }
        ctx.drawImage(img, x, y, iconSize, iconSize);
        ctx.restore();
      });
    },
  };

  new Chart(chartCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Elo",
          data,
          borderWidth: 1,
          borderColor: "#3c2018",
          backgroundColor: [
            "#e8ab97",
            "#e09a81",
            "#d98367",
            "#d97757",
            "#ca6b4b",
            "#bc6141",
            "#ae5637",
            "#9f4b2d",
          ],
          borderRadius: 6,
          maxBarThickness: 72,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          backgroundColor: "#101010",
          borderColor: "#2d2d2d",
          borderWidth: 1,
          titleColor: "#f0f0f0",
          bodyColor: "#d4d4d4",
          callbacks: {
            label(context) {
              return `Elo ${Number(context.raw).toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#b8b8b8",
            maxRotation: 0,
            autoSkip: false,
            font: { family: "JetBrains Mono", size: 11 },
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
        y: {
          min: yMin,
          max: yMax,
          ticks: {
            color: "#8b8b8b",
            font: { family: "JetBrains Mono", size: 11 },
          },
          grid: { color: "rgba(255,255,255,0.07)" },
        },
      },
    },
    plugins: [iconPlugin],
  });
}

function renderEmpty() {
  root.innerHTML = `
    <main class="shell">
      <header class="header">
        <div class="brand">
          <img src="./assets/logo.svg" alt="Quipbench" />
          <h1>Quipbench</h1>
        </div>
      </header>
      <section class="panel">
        <h2>No snapshot found</h2>
        <p>Run a benchmark first: <code>bun run quipbench:run</code></p>
        <p>Then refresh this page. Snapshot expected at <code>bench/out/latest.js</code>.</p>
      </section>
    </main>
  `;
}

function render(snapshotData) {
  const meta = snapshotData.runMeta;
  const leaderboard = snapshotData.leaderboard;
  const champion = leaderboard[0];

  root.innerHTML = `
    <main class="shell">
      <header class="header">
        <div class="brand">
          <img src="./assets/logo.svg" alt="Quipbench" />
          <h1>Quipbench</h1>
        </div>
        <div class="header-links">
          <a href="https://github.com/T3-Content/quipslop" target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.05c-3.34.73-4.04-1.41-4.04-1.41-.55-1.36-1.33-1.72-1.33-1.72-1.09-.73.08-.72.08-.72 1.2.09 1.83 1.2 1.83 1.2 1.07 1.79 2.81 1.27 3.49.97.11-.75.42-1.27.76-1.56-2.67-.3-5.47-1.31-5.47-5.84 0-1.29.47-2.35 1.24-3.18-.13-.3-.54-1.52.12-3.16 0 0 1.01-.32 3.3 1.21a11.63 11.63 0 0 1 6 0c2.28-1.53 3.29-1.21 3.29-1.21.66 1.64.25 2.86.12 3.16.77.83 1.24 1.89 1.24 3.18 0 4.54-2.8 5.54-5.48 5.84.43.37.81 1.09.81 2.21v3.27c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z"/>
            </svg>
            <span>GitHub</span>
          </a>
          <a href="https://quipslop.com/" target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm7.88 9h-3.07a15.9 15.9 0 0 0-1.18-5A8.04 8.04 0 0 1 19.88 11ZM12 4.04c1.04 1.17 1.92 3.24 2.35 5.96H9.65C10.08 7.28 10.96 5.21 12 4.04ZM4.12 13h3.07a15.9 15.9 0 0 0 1.18 5A8.04 8.04 0 0 1 4.12 13Zm3.07-2H4.12a8.04 8.04 0 0 1 4.25-5 15.9 15.9 0 0 0-1.18 5ZM12 19.96c-1.04-1.17-1.92-3.24-2.35-5.96h4.7c-.43 2.72-1.31 4.79-2.35 5.96ZM14.57 13H9.43a14.4 14.4 0 0 1 0-2h5.14a14.4 14.4 0 0 1 0 2Zm1.06 5a15.9 15.9 0 0 0 1.18-5h3.07a8.04 8.04 0 0 1-4.25 5Z"/>
            </svg>
            <span>Website</span>
          </a>
        </div>
        <div class="meta-pills mono">
          <span class="pill">Run ${meta.runId}</span>
          <span class="pill">${meta.roundsCompleted}/${meta.roundsRequested} rounds</span>
          <span class="pill">${meta.failures} failures</span>
        </div>
      </header>

      <section class="panel panel--summary">
        <div class="summary-block">
          <div class="summary-label mono">Started</div>
          <div class="summary-value">${formatDate(meta.startedAt)}</div>
        </div>
        <div class="summary-block">
          <div class="summary-label mono">Ended</div>
          <div class="summary-value">${formatDate(meta.endedAt)}</div>
        </div>
        <div class="summary-block">
          <div class="summary-label mono">Champion</div>
          <div class="summary-value">${champion ? champion.modelName : "-"}</div>
        </div>
        <div class="summary-block">
          <div class="summary-label mono">Seed</div>
          <div class="summary-value mono">${meta.seed}</div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Elo Leaderboard</h2>
        </div>
        <div class="chart-shell">
          <canvas id="elo-chart" aria-label="Elo leaderboard bar chart"></canvas>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Leaderboard Table</h2>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="mono">#</th>
                <th>Model</th>
                <th class="mono">Elo</th>
                <th class="mono">Wins</th>
                <th class="mono">Games</th>
                <th class="mono">Win Rate</th>
              </tr>
            </thead>
            <tbody>
              ${leaderboard.map(rowHtml).join("")}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  `;
}

if (!snapshot || !snapshot.leaderboard) {
  renderEmpty();
} else {
  render(snapshot);
  renderChart(snapshot.leaderboard);
}
