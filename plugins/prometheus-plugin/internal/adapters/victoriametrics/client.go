// Package victoriametrics implements MetricsStore backed by VictoriaMetrics.
// Samples are written using the Prometheus text-format import endpoint:
// POST /api/v1/import/prometheus
package victoriametrics

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	pluginsv1 "github.com/kleffio/plugin-sdk-go/v1"
)

// Client writes Prometheus-format metrics to a VictoriaMetrics instance.
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// New creates a Client that sends metrics to the VictoriaMetrics at baseURL.
// baseURL example: "http://victoria-metrics:8428"
func New(baseURL string) *Client {
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// Ingest encodes the sample as Prometheus text format and POSTs it to
// VictoriaMetrics /api/v1/import/prometheus.
func (c *Client) Ingest(ctx context.Context, s *pluginsv1.MetricSample) error {
	ts := s.Timestamp * 1000 // VictoriaMetrics expects milliseconds

	labels := fmt.Sprintf(
		`workload_id=%q,workload_name=%q,node_id=%q,org_id=%q,project_id=%q`,
		s.WorkloadID, s.WorkloadName, s.NodeID, s.OrgID, s.ProjectID,
	)

	var sb strings.Builder
	if s.CPUMillicores > 0 {
		fmt.Fprintf(&sb, "kleff_workload_cpu_millicores{%s} %d %d\n", labels, s.CPUMillicores, ts)
	}
	if s.MemoryMB > 0 {
		fmt.Fprintf(&sb, "kleff_workload_memory_mb{%s} %d %d\n", labels, s.MemoryMB, ts)
	}
	if s.NetworkRxMB > 0 {
		fmt.Fprintf(&sb, "kleff_workload_network_rx_mb{%s} %g %d\n", labels, s.NetworkRxMB, ts)
	}
	if s.NetworkTxMB > 0 {
		fmt.Fprintf(&sb, "kleff_workload_network_tx_mb{%s} %g %d\n", labels, s.NetworkTxMB, ts)
	}
	if s.DiskReadMB > 0 {
		fmt.Fprintf(&sb, "kleff_workload_disk_read_mb{%s} %g %d\n", labels, s.DiskReadMB, ts)
	}
	if s.DiskWriteMB > 0 {
		fmt.Fprintf(&sb, "kleff_workload_disk_write_mb{%s} %g %d\n", labels, s.DiskWriteMB, ts)
	}

	body := sb.String()
	if body == "" {
		return nil // nothing to write
	}

	url := c.baseURL + "/api/v1/import/prometheus"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewBufferString(body))
	if err != nil {
		return fmt.Errorf("victoriametrics: build request: %w", err)
	}
	req.Header.Set("Content-Type", "text/plain")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("victoriametrics: post metrics: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return fmt.Errorf("victoriametrics: unexpected status %d", resp.StatusCode)
	}
	return nil
}
