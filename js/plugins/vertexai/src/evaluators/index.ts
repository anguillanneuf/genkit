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

import { Action } from 'genkit';
import { GoogleAuth } from 'google-auth-library';
import { PluginOptions } from '..';

let vertexEvaluators;

let VertexAIEvaluationMetricType;

export default async function vertexAiEvaluators(
  projectId: string,
  location: string,
  options: PluginOptions | undefined,
  authClient: GoogleAuth,
  metrics: any
): Promise<Action<any>[]> {
  await initalizeDependencies();
  return vertexEvaluators(authClient, metrics, projectId, location);
}

async function initalizeDependencies() {
  const {
    vertexEvaluators: vertexEvaluatorsImport,
    VertexAIEvaluationMetricType: VertexAIEvaluationMetricTypeImport,
  } = await import('./evaluation.js');

  vertexEvaluators = vertexEvaluatorsImport;
  VertexAIEvaluationMetricType = VertexAIEvaluationMetricTypeImport;
}

export { VertexAIEvaluationMetricType };