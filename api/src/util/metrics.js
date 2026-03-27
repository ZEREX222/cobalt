import { collectDefaultMetrics, Registry, AggregatorRegistry, Counter, Histogram } from 'prom-client';
import cluster from 'node:cluster';

export const WORKER_ID = `worker_${cluster.worker?.id ?? process.pid}`;

export const registry = new Registry();
export const aggregatorRegistry = new AggregatorRegistry();

collectDefaultMetrics({
    registry: registry
});

const httpRequests = new Counter({
    name: "http_requests_total",
    help: "Total HTTP requests",
    labelNames: ["method", "route", "status"],
    registry: [registry]
});

const httpDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status"],
    buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    registry: [registry]
});

const serviceRequestsTotal = new Counter({
    name: "service_requests_total",
    help: "Total requests per service",
    labelNames: ["service"],
    registry: [registry],
});

const serviceRequestsSuccess = new Counter({
    name: "service_requests_success_total",
    help: "Successful requests per service",
    labelNames: ["service",],
    registry: [registry],
});

const serviceRequestsFailed = new Counter({
    name: "service_requests_failed_total",
    help: "Failed requests per service",
    labelNames: ["service", "error_type"],
    registry: [registry],
});

const serviceResponsesTotal = new Counter({
    name: "service_responses_total",
    help: "Total responses by service",
    labelNames: ["type"],
    registry: [registry],
});

const serviceDataDownload = new Counter({
    name: "service_data_download_total",
    help: "Total data downloaded in bytes by service",
    labelNames: ["service"],
    registry: [registry],
});

const failedApiRequests = new Counter({
    name: "failed_api_requests_total",
    help: "Total failed POST requests to API",
    labelNames: ["error"],
    registry: [registry],
});

const totalApiRequests = new Counter({
    name: "api_requests_total",
    help: "Total number of API requests",
    labelNames: ["authType"],
    registry: [aggregatorRegistry]
});

registry.registerMetric(httpRequests);
registry.registerMetric(httpDuration);
registry.registerMetric(serviceRequestsTotal);
registry.registerMetric(serviceRequestsSuccess);
registry.registerMetric(serviceRequestsFailed);
registry.registerMetric(serviceResponsesTotal);
registry.registerMetric(serviceDataDownload);
registry.registerMetric(failedApiRequests);
registry.registerMetric(totalApiRequests);


export function httpRequestMetrics(req, res, next) {
    const endTimer = httpDuration.startTimer();
    const route = req.route?.path || "unknown";

    res.on("finish", () => {
        httpRequests.labels(req.method, route, res.statusCode).inc();
        endTimer({ method: req.method, route, status: res.statusCode });
    });

    next();
}

export function addServiceResponse(type) {
    serviceResponsesTotal.labels(type).inc();
}

export function addServiceRequest(service) {
    serviceRequestsTotal.labels(service).inc();
}

export function addServiceSuccessful(service) {
    serviceRequestsSuccess.labels(service).inc();
}

export function addServiceError(service, error) {
    serviceRequestsFailed.labels(service, error).inc();
}

export function addServiceDataDownload(service, size) {
    serviceDataDownload.labels(service).inc(size);
}

export function addFailedApiRequest(error) {
    failedApiRequests.labels(error).inc();
}

export function addApiRequest(authType) {
    totalApiRequests.labels(authType).inc();
}