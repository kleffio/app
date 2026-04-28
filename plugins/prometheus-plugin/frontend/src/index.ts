import { definePlugin } from "@kleffio/sdk";
import { MonitoringCharts } from "./MonitoringCharts";

const prometheusPlugin = definePlugin({
  manifest: {
    id: "kleff.observability-prometheus",
    name: "Prometheus Metrics",
    version: "0.1.0",
    description: "Time-series charts powered by VictoriaMetrics.",
    slots: [
      {
        slot: "monitoring.charts",
        component: MonitoringCharts,
      },
    ],
  },
});

if (typeof window !== "undefined" && (window as any).__kleff__?.registry) {
  (window as any).__kleff__.registry.register(prometheusPlugin);
}
