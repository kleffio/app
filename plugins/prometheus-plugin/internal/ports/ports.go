package ports

import (
	"context"

	pluginsv1 "github.com/kleffio/plugin-sdk-go/v1"
)

// MetricsStore writes metric samples to the underlying time-series backend.
type MetricsStore interface {
	Ingest(ctx context.Context, sample *pluginsv1.MetricSample) error
}
