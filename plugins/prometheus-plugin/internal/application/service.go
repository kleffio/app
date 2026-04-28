package application

import (
	"context"

	pluginsv1 "github.com/kleffio/plugin-sdk-go/v1"
	"github.com/kleffio/observability-prometheus/internal/ports"
)

// Service implements the observability framework application logic.
type Service struct {
	store ports.MetricsStore
}

// New creates a Service backed by the given MetricsStore.
func New(store ports.MetricsStore) *Service {
	return &Service{store: store}
}

// IngestMetrics validates and forwards a sample to the metrics store.
func (s *Service) IngestMetrics(ctx context.Context, sample *pluginsv1.MetricSample) error {
	if sample == nil {
		return nil
	}
	return s.store.Ingest(ctx, sample)
}
