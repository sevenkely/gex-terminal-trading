/* OHLCV estimates only. Pure functions shared by browser and offline tests. */
(function (root) {
  "use strict";
  const formatters = new Map();
  const dayMs = 86400000;
  function dateParts(time, zone) {
    if (!formatters.has(zone))
      formatters.set(
        zone,
        new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }),
      );
    return Object.fromEntries(
      formatters
        .get(zone)
        .formatToParts(new Date(time * 1000))
        .map((p) => [p.type, p.value]),
    );
  }
  function session(time, config, symbol) {
    const mode =
      config.session === "auto"
        ? symbol === "BTC"
          ? "day"
          : ["ES", "NQ", "GC"].includes(symbol)
            ? "eth"
            : "rth"
        : config.session;
    const zone = mode === "day" ? config.zone : "America/New_York";
    const p = dateParts(time, zone),
      minute = +p.hour * 60 + +p.minute;
    if (mode === "rth" && (minute < 570 || minute >= 960)) return null;
    if (mode === "eth" && minute >= 1020 && minute < 1080) return null;
    const stamp = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day + (mode === "eth" && minute >= 1080 ? 1 : 0),
    );
    return {
      day: new Date(stamp).toISOString().slice(0, 10),
      stamp,
      mode,
      zone,
    };
  }
  function key(info, period) {
    if (period === "weekly") {
      const d = new Date(info.stamp),
        weekday = (d.getUTCDay() + 6) % 7;
      return new Date(info.stamp - weekday * dayMs).toISOString().slice(0, 10);
    }
    if (period === "monthly") return info.day.slice(0, 7) + "-01";
    return info.day;
  }
  function normalize(input) {
    const unique = new Map();
    for (const row of input || []) {
      if (
        typeof row.time !== "number" ||
        !Number.isFinite(row.time) ||
        ![row.high, row.low, row.close, row.volume].every(Number.isFinite) ||
        row.low <= 0 ||
        row.high < row.low ||
        row.close < row.low ||
        row.close > row.high ||
        row.volume < 0
      )
        continue;
      unique.set(row.time, { ...row });
    }
    return [...unique.values()].sort((a, b) => a.time - b.time);
  }
  function groups(input, config, symbol, visible) {
    const rows = normalize(input),
      out = new Map();
    for (const row of rows) {
      const info = session(row.time, config, symbol);
      if (!info) continue;
      if (
        config.period === "anchored" &&
        (!Number.isFinite(config.anchor) || row.time < config.anchor)
      )
        continue;
      if (
        config.period === "visible" &&
        (!visible || row.time < visible.from || row.time > visible.to)
      )
        continue;
      const k = ["anchored", "visible"].includes(config.period)
        ? config.period
        : key(info, config.period);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(row);
    }
    return [...out].map(([period, bars]) => ({ period, bars }));
  }
  function profile(bars, config) {
    if (!bars.length) return null;
    const positive = bars.filter((b) => b.volume > 0);
    if (!positive.length) return null;
    let lo = Infinity,
      hi = -Infinity;
    for (const b of positive) {
      lo = Math.min(lo, b.low);
      hi = Math.max(hi, b.high);
    }
    let count = config.rows,
      step;
    if (config.resolution === "step") {
      step = config.step;
      lo = Math.floor(lo / step) * step;
      count = Math.max(1, Math.ceil((hi - lo) / step));
      if (count > 512)
        return {
          error: "Pas trop fin : plus de 512 niveaux. Augmentez le pas.",
        };
    } else step = (hi - lo) / count || Math.max(lo * 0.000001, 0.000001);
    const vol = Array(count).fill(0);
    for (const b of positive) {
      const start = Math.min(
        count - 1,
        Math.max(0, Math.floor((b.low - lo) / step)),
      );
      const end = Math.min(
        count - 1,
        Math.max(start, Math.floor((b.high - lo) / step)),
      );
      const each = b.volume / (end - start + 1);
      for (let i = start; i <= end; i++) vol[i] += each;
    }
    const total = vol.reduce((a, b) => a + b, 0),
      max = Math.max(...vol),
      pocIndex = vol.indexOf(max);
    let a = pocIndex,
      b = pocIndex,
      sum = vol[a];
    while (sum < (total * config.valueArea) / 100 && (a > 0 || b < count - 1)) {
      if (a > 0 && (b === count - 1 || vol[a - 1] >= vol[b + 1]))
        sum += vol[--a];
      else sum += vol[++b];
    }
    return {
      lo,
      step,
      vol,
      total,
      max,
      poc: lo + (pocIndex + 0.5) * step,
      vah: lo + (b + 1) * step,
      val: lo + a * step,
      areaLow: a,
      areaHigh: b,
      first: bars[0].time,
      last: bars.at(-1).time,
      count: bars.length,
    };
  }
  function vwap(bars) {
    let total = 0,
      mean = 0,
      m2 = 0;
    const points = [];
    for (const b of bars) {
      if (!(b.volume > 0)) continue;
      const price = (b.high + b.low + b.close) / 3;
      // Weighted Welford: stable variance even for high nominal prices.
      const next = total + b.volume,
        delta = price - mean;
      mean += (b.volume / next) * delta;
      m2 += b.volume * delta * (price - mean);
      total = next;
      points.push({
        time: b.time,
        value: mean,
        sd: Math.sqrt(Math.max(0, m2 / total)),
        volume: total,
      });
    }
    return points;
  }
  const defaults = {
    version: 1,
    base: "5m",
    vp: {
      enabled: true,
      period: "daily",
      session: "auto",
      zone: "UTC",
      anchor: null,
      history: "current",
      resolution: "rows",
      rows: 64,
      step: 10,
      valueArea: 70,
      side: "left",
      width: 14,
      opacity: 0.27,
      color: "#54c9cb",
      outside: "#627bc4",
      poc: true,
      va: true,
    },
    vwap: {
      enabled: true,
      period: "daily",
      session: "auto",
      zone: "UTC",
      anchor: null,
      previous: false,
      bands: "sigma",
      bandCount: 2,
      percent: 1,
      color: "#d5e7ee",
      width: 2,
      style: "solid",
      labels: true,
    },
  };
  function sanitize(raw) {
    const result = JSON.parse(JSON.stringify(defaults));
    if (!raw || typeof raw !== "object") return result;
    if (["1m", "5m", "15m", "30m", "1h"].includes(raw.base))
      result.base = raw.base;
    const lists = {
      period: ["daily", "weekly", "monthly", "visible", "anchored"],
      session: ["auto", "day", "rth", "eth"],
      zone: ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"],
      history: ["current", "previous", "three"],
      resolution: ["rows", "step"],
      side: ["left", "right"],
      bands: ["none", "sigma", "percent"],
      style: ["solid", "dashed", "dotted"],
    };
    for (const name of ["vp", "vwap"]) {
      const config = raw[name];
      if (!config || typeof config !== "object") continue;
      for (const [field, value] of Object.entries(config)) {
        if (!(field in result[name])) continue;
        if (lists[field]) {
          if (
            lists[field].includes(value) &&
            !(name === "vwap" && field === "period" && value === "visible")
          )
            result[name][field] = value;
        } else if (typeof result[name][field] === "boolean") {
          if (typeof value === "boolean") result[name][field] = value;
        } else if (["color", "outside"].includes(field)) {
          if (/^#[0-9a-f]{6}$/i.test(value)) result[name][field] = value;
        } else if (field === "anchor") {
          if (value === null || (Number.isFinite(value) && value > 0))
            result[name][field] = value;
        } else if (Number.isFinite(value)) {
          const limits = {
            rows: [8, 256],
            step: [0.000001, 1e7],
            valueArea: [1, 100],
            width: name === "vp" ? [5, 35] : [1, 5],
            opacity: [0.05, 0.8],
            bandCount: [1, 3],
            percent: [0.01, 20],
          }[field];
          if (limits)
            result[name][field] = Math.max(
              limits[0],
              Math.min(limits[1], value),
            );
        }
      }
      if (name === "vp") result.vp.rows = Math.round(result.vp.rows);
      else result.vwap.bandCount = Math.round(result.vwap.bandCount);
    }
    return result;
  }
  const api = {
    session,
    key,
    normalize,
    groups,
    profile,
    vwap,
    sanitize,
    defaults,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IndicatorMath = api;
})(typeof window !== "undefined" ? window : globalThis);
