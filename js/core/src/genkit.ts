/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import * as bodyParser from 'body-parser';
import { CorsOptions, default as cors } from 'cors';
import express from 'express';
import { Server } from 'http';
import z from 'zod';
import {
  CallableFlow,
  Flow,
  FlowConfig,
  FlowFn,
  StreamableFlow,
  StreamingFlowConfig,
  defineFlow,
  defineStreamingFlow,
} from './flow.js';
import { logger } from './logging.js';
import { PluginProvider } from './plugin.js';
import { ReflectionServer } from './reflection.js';
import * as registry from './registry.js';
import { AsyncProvider, Registry, runWithRegistry } from './registry.js';
import {
  LoggerConfig,
  TelemetryConfig,
  TelemetryOptions,
} from './telemetryTypes.js';
import {
  cleanUpTracing,
  enableTracingAndMetrics,
} from './tracing.js';

/**
 * Options for initializing Genkit.
 */
export interface GenkitOptions {
  /** List of plugins to load. */
  plugins?: PluginProvider[];
  /** Name of the trace store to use. If not specified, a dev trace store will be used. The trace store must be registered in the config. */
  traceStore?: string;
  /** Name of the flow state store to use. If not specified, a dev flow state store will be used. The flow state store must be registered in the config. */
  flowStateStore?: string;
  /** Whether to enable tracing and metrics. */
  enableTracingAndMetrics?: boolean;
  /** Level at which to log messages.*/
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
  /** Directory where dotprompts are stored. */
  promptDir?: string;
  /** Telemetry configuration. */
  telemetry?: TelemetryOptions;
  /** Default model to use if no model is specified. */
  defaultModel?: {
    /** Name of the model to use. */
    name: string | { name: string };
    /** Configuration for the model. */
    config?: Record<string, any>;
  };
  /** Configuration for the flow server. */
  flowServer?: FlowServerOptions;
}

/**
 * Flow server exposes defined flows as HTTP endpoints.
 */
export interface FlowServerOptions {
  /** Whether to automatically start the flow server. */
  enabled: boolean;
  /** List of flows to expose via the flow server. If not specified, all registered flows will be exposed. */
  flows?: Flow<any, any, any>[];
  /** Port to run the server on. */
  port?: number;
  /** CORS options for the server. */
  cors?: CorsOptions;
  /** HTTP method path prefix for the exposed flows. */
  pathPrefix?: string;
  /** JSON body parser options. */
  jsonParserOptions?: bodyParser.OptionsJson;
}

/**
 * Genkit encapsulates a single Genkit instance including the registry, reflection server, flows server, and configuration.
 *
 * There may be multiple Genkit instances in a single codebase.
 */
export class Genkit {
  /** Developer-configured options. */
  readonly options: GenkitOptions;
  /** Environments that have been configured (at minimum dev). */
  readonly configuredEnvs = new Set<string>(['dev']);
  /** Registry instance that is exclusively modified by this Genkit instance. */
  readonly registry: Registry;

  /** Async provider for the telemtry configuration. */
  private telemetryConfig: AsyncProvider<TelemetryConfig>;
  /** Async provider for the logger configuration. */
  private loggerConfig?: AsyncProvider<LoggerConfig>;
  /** Reflection server for this registry. May be null if not started. */
  private reflectionServer: ReflectionServer | null = null;
  /** Flow server. May be null if the flow server is not enabled in configuration or not started. */
  private flowServer: Server | null = null;
  /** List of flows that have been registered in this instance. */
  private registeredFlows: Flow<any, any, any>[] = [];

  constructor(options?: GenkitOptions) {
    this.options = options || {};
    this.telemetryConfig = async () =>
      <TelemetryConfig>{
        getConfig() {
          return {} as Partial<NodeSDKConfiguration>;
        },
      };
    this.registry = new Registry();
    // runWithRegistry is used instead of calling this.registry throughout this class for
    // backwards-compatibility with existing plugins that operate on a global registry.
    runWithRegistry(this.registry, () => {
      this.configure();
    });
    if (isDevEnv()) {
      this.startReflectionServer();
    }
    this.startFlowServer();
  }

  /**
   * Defines a flow.
   */
  defineFlow<
    I extends z.ZodTypeAny = z.ZodTypeAny,
    O extends z.ZodTypeAny = z.ZodTypeAny,
  >(config: FlowConfig<I, O>, fn: FlowFn<I, O>): CallableFlow<I, O> {
    const flow = runWithRegistry(this.registry, () => defineFlow(config, fn));
    this.registeredFlows.push(flow.flow);
    return flow;
  }

  /**
   * Defines a streaming flow.
   */
  defineStreamingFlow<
    I extends z.ZodTypeAny = z.ZodTypeAny,
    O extends z.ZodTypeAny = z.ZodTypeAny,
    S extends z.ZodTypeAny = z.ZodTypeAny,
  >(
    config: StreamingFlowConfig<I, O, S>,
    fn: FlowFn<I, O, S>
  ): StreamableFlow<I, O, S> {
    const flow = runWithRegistry(this.registry, () =>
      defineStreamingFlow(config, fn)
    );
    this.registeredFlows.push(flow.flow);
    return flow;
  }

  /**
   * Returns the configuration for exporting Telemetry data for the current
   * environment.
   */
  public getTelemetryConfig(): Promise<TelemetryConfig> {
    return this.telemetryConfig();
  }

  /**
   * Starts the reflection server.
   */
  private startReflectionServer() {
    this.reflectionServer = new ReflectionServer({ registry: this.registry });
    this.reflectionServer.start();
  }

  /**
   * Starts the flow server.
   */
  private startFlowServer() {
    if (!this.options.flowServer?.enabled) {
      return;
    }
    const port =
      this.options.flowServer?.port ||
      (process.env.PORT ? parseInt(process.env.PORT) : 0) ||
      3400;
    const pathPrefix = this.options.flowServer?.pathPrefix ?? '';
    const app = express();
    app.use(bodyParser.json(this.options.flowServer?.jsonParserOptions));
    app.use(cors(this.options.flowServer?.cors));

    const flows = this.options.flowServer?.flows || this.registeredFlows;
    flows.forEach((flow) => {
      const flowPath = `/${pathPrefix}${flow.name}`;
      logger.info(` - ${flowPath}`);
      flow.middleware?.forEach((middleware) => app.post(flowPath, middleware));
      app.post(flowPath, (req, res) =>
        flow.expressHandler(this.registry, req, res)
      );
    });

    this.flowServer = app.listen(port, () => {
      logger.info(`Flow server listening on port ${port}`);
    });
  }

  /**
   * Configures the Genkit instance.
   */
  private configure() {
    if (this.options.logLevel) {
      logger.setLogLevel(this.options.logLevel);
    }

    this.options.plugins?.forEach((plugin) => {
      logger.debug(`Registering plugin ${plugin.name}...`);
      registry.registerPluginProvider(plugin.name, {
        name: plugin.name,
        async initializer() {
          logger.info(`Initializing plugin ${plugin.name}:`);
          return await plugin.initializer();
        },
      });
    });

    if (this.options.telemetry?.logger) {
      const loggerPluginName = this.options.telemetry.logger;
      logger.debug('Registering logging exporters...');
      logger.debug(`  - all environments: ${loggerPluginName}`);
      this.loggerConfig = async () =>
        this.resolveLoggerConfig(loggerPluginName);
    }

    if (this.options.telemetry?.instrumentation) {
      const telemetryPluginName = this.options.telemetry.instrumentation;
      logger.debug('Registering telemetry exporters...');
      logger.debug(`  - all environments: ${telemetryPluginName}`);
      this.telemetryConfig = async () =>
        this.resolveTelemetryConfig(telemetryPluginName);
    }
  }

  /**
   * Sets up the tracing and logging as configured.
   *
   * Note: the logging configuration must come after tracing has been enabled to
   * ensure that all tracing instrumentations are applied.
   * See limitations described here:
   * https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/opentelemetry-instrumentation#limitations
   */
  async setupTracingAndLogging() {
    if (this.options.enableTracingAndMetrics) {
      enableTracingAndMetrics(await this.getTelemetryConfig());
    }
    if (this.loggerConfig) {
      logger.init(await this.loggerConfig());
    }
  }

  /**
   * Resolves trace store provided by the specified plugin.
   */
  private async resolveTraceStore(pluginName: string) {
    let traceStoreId;
    if (pluginName.includes('/')) {
      const tokens = pluginName.split('/', 2);
      pluginName = tokens[0];
      traceStoreId = tokens[1];
    }
    const plugin = await registry.initializePlugin(pluginName);
    let provider = plugin?.traceStore;
    if (!provider) {
      throw new Error(
        'Unable to resolve provided `traceStore` for plugin: ' + pluginName
      );
    }
    if (!Array.isArray(provider)) {
      provider = [provider];
    }
    if (provider.length === 1 && !traceStoreId) {
      return provider[0].value;
    }
    if (provider.length > 1 && !traceStoreId) {
      throw new Error(
        `Plugin ${pluginName} provides more than one trace store implementation (${provider.map((p) => p.id).join(', ')}), please specify the trace store id (e.g. "${pluginName}/${provider[0].id}")`
      );
    }
    const p = provider.find((p) => p.id === traceStoreId);
    if (!p) {
      throw new Error(
        `Plugin ${pluginName} does not provide trace store ${traceStoreId}`
      );
    }
    return p.value;
  }

  /**
   * Resolves the telemetry configuration provided by the specified plugin.
   */
  private async resolveTelemetryConfig(pluginName: string) {
    const plugin = await registry.initializePlugin(pluginName);
    const provider = plugin?.telemetry?.instrumentation;

    if (!provider) {
      throw new Error(
        'Unable to resolve provider `telemetry.instrumentation` for plugin: ' +
          pluginName
      );
    }
    return provider.value;
  }

  /**
   * Resolves the logging configuration provided by the specified plugin.
   */
  private async resolveLoggerConfig(pluginName: string) {
    const plugin = await registry.initializePlugin(pluginName);
    const provider = plugin?.telemetry?.logger;

    if (!provider) {
      throw new Error(
        'Unable to resolve provider `telemetry.logger` for plugin: ' +
          pluginName
      );
    }
    return provider.value;
  }
}

/**
 * Initializes Genkit with a set of options.
 *
 * This will create a new Genkit registry, register the provided plugins, stores, and other configuration. This
 * should be called before any flows are registered.
 */
export function initializeGenkit(options: GenkitOptions): Genkit {
  const genkit = new Genkit(options);
  genkit.setupTracingAndLogging();
  return genkit;
}

/**
 * @returns The current environment that the app code is running in.
 */
export function getCurrentEnv(): string {
  return process.env.GENKIT_ENV || 'prod';
}

/** Whether current env is `dev`. */
export function isDevEnv(): boolean {
  return getCurrentEnv() === 'dev';
}

process.on('SIGTERM', async () => {
  logger.debug(
    'Received SIGTERM. Shutting down all reflection servers and cleaning up tracing...'
  );
  await Promise.all([ReflectionServer.stopAll(), cleanUpTracing()]);
  // TODO: Stop flow server.
  process.exit(0);
});