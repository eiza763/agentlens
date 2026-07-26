/**
 * OpenTelemetry wiring for SigNoz Cloud.
 *
 * Both AgentLens processes (the agent under test and the evaluator) initialise
 * telemetry through here, so traces and metrics land in the same workspace with
 * consistent resource attributes.
 *
 * This module must be imported *before* anything that emits telemetry.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { metrics, trace, type Tracer, type Meter } from "@opentelemetry/api";
import { config } from "../config.js";

let sdk: NodeSDK | undefined;
let metricReader: PeriodicExportingMetricReader | undefined;

export interface InitOptions {
  serviceName: string;
  /** Extra resource attributes, e.g. the variant of the agent being tested. */
  attributes?: Record<string, string>;
}

export function initTelemetry({ serviceName, attributes = {} }: InitOptions): void {
  if (sdk) return;

  // Self-hosted collectors take no ingestion key; sending an empty header value
  // makes some collectors reject the request outright, so omit it entirely.
  const key = config.signozIngestionKey;
  const headers: Record<string, string> = key ? { "signoz-ingestion-key": key } : {};
  const endpoint = config.otlpEndpoint;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment.name": "hackathon",
    ...attributes,
  });

  metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, headers }),
    // Short interval so a 60-second demo actually shows points on the dashboard.
    exportIntervalMillis: 10_000,
  });

  sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
    metricReaders: [metricReader],
  });

  sdk.start();
}

/**
 * Flush both pipelines and shut down. Short-lived CLI processes MUST await this
 * or the last spans and metrics of the run are silently dropped on exit.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await metricReader?.forceFlush();
    await sdk.shutdown();
  } catch (err) {
    console.error("[otel] flush/shutdown failed:", err);
  }
  sdk = undefined;
  metricReader = undefined;
}

export function tracer(): Tracer {
  return trace.getTracer("agentlens", "1.0.0");
}

export function meter(): Meter {
  return metrics.getMeter("agentlens", "1.0.0");
}
