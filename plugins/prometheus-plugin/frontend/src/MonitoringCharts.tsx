import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { usePluginContext } from "@kleffio/sdk";

interface Props {
  projectId?: string;
  refreshKey?: number;
}

interface PromResult {
  metric: Record<string, string>;
  values: [number, string][];
}

interface PromResponse {
  status: string;
  data: {
    resultType: string;
    result: PromResult[];
  };
}

interface DataPoint {
  time: string;
  [workload: string]: string | number;
}

function toLabel(metric: Record<string, string>) {
  return metric.workload_name || metric.workload_id || "unknown";
}

const COLORS = ["#6366f1", "#22d3ee", "#f59e0b", "#34d399", "#f87171", "#a78bfa"];
const TOTAL_COLOR = "#818cf8";

function useQueryRange(
  api: ReturnType<typeof usePluginContext>["api"],
  query: string,
  rangeSeconds: number,
  step: number,
  refreshKey?: number,
) {
  const [data, setData] = useState<DataPoint[]>([]);

  const fetch = useCallback(async () => {
    const now = Math.floor(Date.now() / 1000);
    const start = now - rangeSeconds;
    const params = new URLSearchParams({
      query,
      start: String(start),
      end: String(now),
      step: String(step),
    });
    try {
      const resp = await api.get<PromResponse>(
        `/api/v1/metrics/query_range?${params}`
      );
      if (resp.status !== "success") return;

      const timeMap = new Map<number, DataPoint>();
      for (const series of resp.data.result) {
        const label = toLabel(series.metric);
        for (const [ts, val] of series.values) {
          if (!timeMap.has(ts)) {
            timeMap.set(ts, {
              time: new Date(ts * 1000).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              }),
            });
          }
          timeMap.get(ts)![label] = parseFloat(parseFloat(val).toFixed(2));
        }
      }
      setData(Array.from(timeMap.values()).sort((a, b) => a.time < b.time ? -1 : 1));
    } catch {
      // silently ignore — the monitoring plugin may not be installed
    }
  }, [api, query, rangeSeconds, step, refreshKey]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 60_000);
    return () => clearInterval(id);
  }, [fetch]);

  return data;
}

function allKeys(data: DataPoint[]) {
  const keys = new Set<string>();
  for (const point of data) {
    for (const k of Object.keys(point)) {
      if (k !== "time") keys.add(k);
    }
  }
  return [...keys];
}

function toTotalData(data: DataPoint[]): DataPoint[] {
  return data.map((point) => {
    let sum = 0;
    for (const [k, v] of Object.entries(point)) {
      if (k !== "time" && typeof v === "number") sum += v;
    }
    return { time: point.time, Total: parseFloat(sum.toFixed(2)) };
  });
}

function toFilteredData(data: DataPoint[], selected: Set<string>): DataPoint[] {
  return data.map((point) => {
    const out: DataPoint = { time: point.time };
    for (const [k, v] of Object.entries(point)) {
      if (k !== "time" && selected.has(k)) out[k] = v;
    }
    return out;
  });
}

// ── Dropdown ──────────────────────────────────────────────────────────────────

interface DropdownProps {
  allWorkloads: string[];
  colorMap: Map<string, string>;
  showTotal: boolean;
  selected: Set<string>;
  onTotalChange: (v: boolean) => void;
  onToggle: (wl: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}

function WorkloadDropdown({
  allWorkloads,
  colorMap,
  showTotal,
  selected,
  onTotalChange,
  onToggle,
  onSelectAll,
  onClearAll,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const label = showTotal
    ? "Total (combined)"
    : selected.size === allWorkloads.length
    ? `All workloads (${allWorkloads.length})`
    : selected.size === 0
    ? "None selected"
    : selected.size === 1
    ? [...selected][0]
    : `${selected.size} of ${allWorkloads.length} workloads`;

  return (
    <div ref={ref} style={{ position: "relative", userSelect: "none" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          borderRadius: 8,
          fontSize: 11,
          cursor: "pointer",
          border: "1px solid rgba(255,255,255,0.1)",
          background: "rgba(255,255,255,0.04)",
          color: "rgba(255,255,255,0.6)",
          whiteSpace: "nowrap",
        }}
      >
        <span>View: {label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ opacity: 0.5, transform: open ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }}>
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 50,
            minWidth: 220,
            maxHeight: 320,
            overflowY: "auto",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.09)",
            background: "var(--popover)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
            padding: "6px 0",
          }}
        >
          {/* Total option */}
          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={showTotal}
              onChange={(e) => onTotalChange(e.target.checked)}
              style={{ accentColor: TOTAL_COLOR }}
            />
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: TOTAL_COLOR, flexShrink: 0 }} />
            <span style={{ color: "rgba(255,255,255,0.7)" }}>Total (combined)</span>
          </label>

          <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "4px 0" }} />

          {/* Select/Clear all */}
          <div style={{ display: "flex", gap: 6, padding: "4px 10px 6px" }}>
            <button onClick={onSelectAll} style={actionBtn}>Select all</button>
            <button onClick={onClearAll} style={{ ...actionBtn, color: "rgba(255,100,100,0.5)" }}>Clear all</button>
          </div>

          {/* Individual workloads */}
          {allWorkloads.map((wl) => {
            const color = colorMap.get(wl) ?? COLORS[0];
            const checked = selected.has(wl);
            return (
              <label key={wl} style={rowStyle}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(wl)}
                  style={{ accentColor: color }}
                />
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
                <span
                  style={{
                    color: checked ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.3)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={wl}
                >
                  {wl}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 12px",
  fontSize: 11,
  cursor: "pointer",
  width: "100%",
};

const actionBtn: React.CSSProperties = {
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 5,
  padding: "2px 8px",
  fontSize: 10,
  color: "rgba(255,255,255,0.4)",
  cursor: "pointer",
};

// ── Chart ─────────────────────────────────────────────────────────────────────

function Chart({
  title,
  unit,
  data,
  colorMap,
  showTotal,
}: {
  title: string;
  unit: string;
  data: DataPoint[];
  colorMap: Map<string, string>;
  showTotal: boolean;
}) {
  const workloads = useMemo(() => allKeys(data), [data]);

  return (
    <div
      style={{
        borderRadius: 12,
        border: "1px solid rgba(255,255,255,0.07)",
        background: "var(--card)",
        padding: "20px 24px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
      }}
    >
      <p style={{ margin: "0 0 16px", fontSize: 13, fontWeight: 600 }}>
        {title}
        <span style={{ fontWeight: 400, fontSize: 11, opacity: 0.4, marginLeft: 6 }}>({unit})</span>
      </p>
      {data.length === 0 ? (
        <div
          style={{
            height: 140,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            color: "rgba(255,255,255,0.25)",
          }}
        >
          No data yet
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: "rgba(255,255,255,0.3)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "rgba(255,255,255,0.3)" }}
              tickLine={false}
              axisLine={false}
              width={45}
            />
            <Tooltip
              contentStyle={{
                background: "var(--card)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 8,
                fontSize: 11,
              }}
              labelStyle={{ color: "rgba(255,255,255,0.5)", marginBottom: 4 }}
              formatter={(v: number) => [`${v} ${unit}`, ""]}
            />
            {workloads.map((wl) => (
              <Line
                key={wl}
                type="monotone"
                dataKey={wl}
                stroke={showTotal ? TOTAL_COLOR : (colorMap.get(wl) ?? COLORS[0])}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export function MonitoringCharts({ projectId, refreshKey }: Props) {
  const { api } = usePluginContext();

  const cpuQuery = projectId
    ? `sum by (workload_name, workload_id) (kleff_workload_cpu_millicores{project_id="${projectId}"})`
    : `sum by (workload_name, workload_id) (kleff_workload_cpu_millicores)`;

  const memQuery = projectId
    ? `sum by (workload_name, workload_id) (kleff_workload_memory_mb{project_id="${projectId}"})`
    : `sum by (workload_name, workload_id) (kleff_workload_memory_mb)`;

  const cpuMillicores = useQueryRange(api, cpuQuery, 3600, 60, refreshKey);
  const memData = useQueryRange(api, memQuery, 3600, 60, refreshKey);

  const cpuData = useMemo(() => cpuMillicores.map((point) => {
    const converted: DataPoint = { time: point.time };
    for (const [k, v] of Object.entries(point)) {
      if (k === "time") continue;
      converted[k] = typeof v === "number" ? parseFloat((v / 1000).toFixed(3)) : v;
    }
    return converted;
  }), [cpuMillicores]);

  const allWorkloads = useMemo(() => {
    const keys = new Set([...allKeys(cpuData), ...allKeys(memData)]);
    return [...keys].sort();
  }, [cpuData, memData]);

  const colorMap = useMemo(() => {
    const m = new Map<string, string>();
    allWorkloads.forEach((wl, i) => m.set(wl, COLORS[i % COLORS.length]));
    return m;
  }, [allWorkloads]);

  const [showTotal, setShowTotal] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const wl of allWorkloads) {
        if (!next.has(wl)) { next.add(wl); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [allWorkloads]);

  const toggle = (wl: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(wl) ? next.delete(wl) : next.add(wl);
      return next;
    });

  const displayCpu = showTotal ? toTotalData(cpuData) : toFilteredData(cpuData, selected);
  const displayMem = showTotal ? toTotalData(memData) : toFilteredData(memData, selected);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {allWorkloads.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <WorkloadDropdown
            allWorkloads={allWorkloads}
            colorMap={colorMap}
            showTotal={showTotal}
            selected={selected}
            onTotalChange={setShowTotal}
            onToggle={toggle}
            onSelectAll={() => setSelected(new Set(allWorkloads))}
            onClearAll={() => setSelected(new Set())}
          />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Chart title="CPU Usage" unit="cores" data={displayCpu} colorMap={colorMap} showTotal={showTotal} />
        <Chart title="Memory Usage" unit="MB" data={displayMem} colorMap={colorMap} showTotal={showTotal} />
      </div>
    </div>
  );
}
