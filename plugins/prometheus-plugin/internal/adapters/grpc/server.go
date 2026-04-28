// Package grpc is the inbound gRPC adapter for the prometheus monitoring plugin.
package grpc

import (
	"context"

	pluginsv1 "github.com/kleffio/plugin-sdk-go/v1"
	"github.com/kleffio/observability-prometheus/internal/application"
)

// Server implements all gRPC service interfaces for this plugin.
type Server struct {
	pluginsv1.UnimplementedPluginHealthServer
	pluginsv1.UnimplementedMonitoringFrameworkServer
	svc *application.Service
}

// New creates a Server wired to the given application service.
func New(svc *application.Service) *Server {
	return &Server{svc: svc}
}

// Health reports the plugin as healthy.
func (s *Server) Health(_ context.Context, _ *pluginsv1.HealthRequest) (*pluginsv1.HealthResponse, error) {
	return &pluginsv1.HealthResponse{Status: pluginsv1.HealthStatusHealthy}, nil
}

// GetCapabilities declares the monitoring.metrics capability.
func (s *Server) GetCapabilities(_ context.Context, _ *pluginsv1.GetCapabilitiesRequest) (*pluginsv1.GetCapabilitiesResponse, error) {
	return &pluginsv1.GetCapabilitiesResponse{
		Capabilities: []string{pluginsv1.CapabilityMonitoringMetrics},
	}, nil
}

// IngestMetrics receives a metric sample from the platform and writes it to VictoriaMetrics.
func (s *Server) IngestMetrics(ctx context.Context, req *pluginsv1.IngestMetricsRequest) (*pluginsv1.IngestMetricsResponse, error) {
	if err := s.svc.IngestMetrics(ctx, req.Sample); err != nil {
		return &pluginsv1.IngestMetricsResponse{
			Error: &pluginsv1.PluginError{
				Code:    pluginsv1.ErrorCodeInternal,
				Message: err.Error(),
			},
		}, nil
	}
	return &pluginsv1.IngestMetricsResponse{}, nil
}

// SupportsBillingMetrics indicates this plugin does not yet support billing-grade metrics.
func (s *Server) SupportsBillingMetrics(_ context.Context, _ *pluginsv1.SupportsBillingMetricsRequest) (*pluginsv1.SupportsBillingMetricsResponse, error) {
	return &pluginsv1.SupportsBillingMetricsResponse{Supported: false}, nil
}
