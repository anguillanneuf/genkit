// Copyright 2024 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// This program can be manually tested like so:
//
// In development mode (with the environment variable GENKIT_ENV="dev"):
// Start the server listening on port 3100:
//
//	go run . &
//
// Tell it to run a flow:
//
//	curl -d '{"key":"/flow/simpleGreeting/simpleGreeting", "input":{"start": {"input":{"customerName": "John Doe"}}}}' http://localhost:3100/api/runAction
//
// In production mode (GENKIT_ENV missing or set to "prod"):
// Start the server listening on port 3400:
//
//	go run . &
//
// Tell it to run a flow:
//
//  curl -d '{"customerName": "Stimpy"}' http://localhost:3400/simpleGreeting

package main

import (
	"context"
	"log"

	"github.com/firebase/genkit/go/ai"
	"github.com/firebase/genkit/go/genkit"
	"github.com/firebase/genkit/go/plugins/dotprompt"
	"github.com/firebase/genkit/go/plugins/googleai"
	"github.com/invopop/jsonschema"
)

const simpleGreetingPromptTemplate = `
You're a barista at a nice coffee shop.
A regular customer named {{customerName}} enters.
Greet the customer in one sentence, and recommend a coffee drink.
`

const simpleStructuredGreetingPromptTemplate = `
You're a barista at a nice coffee shop.
A regular customer named {{customerName}} enters.
Greet the customer in one sentence.
Provide the name of the drink of the day, nothing else.
`

type simpleGreetingInput struct {
	CustomerName string `json:"customerName"`
}

type simpleGreetingOutput struct {
	CustomerName string `json:"customerName"`
	Greeting     string `json:"greeting,omitempty"`
	DrinkOfDay   string `json:"drinkOfDay"`
}

const greetingWithHistoryPromptTemplate = `
{{role "user"}}
Hi, my name is {{customerName}}. The time is {{currentTime}}. Who are you?

{{role "model"}}
I am Barb, a barista at this nice underwater-themed coffee shop called Krabby Kooffee.
I know pretty much everything there is to know about coffee,
and I can cheerfully recommend delicious coffee drinks to you based on whatever you like.

{{role "user"}}
Great. Last time I had {{previousOrder}}.
I want you to greet me in one sentence, and recommend a drink.
`

type customerTimeAndHistoryInput struct {
	CustomerName  string `json:"customerName"`
	CurrentTime   string `json:"currentTime"`
	PreviousOrder string `json:"previousOrder"`
}

type testAllCoffeeFlowsOutput struct {
	Pass    bool     `json:"pass"`
	Replies []string `json:"replies,omitempty"`
	Error   string   `json:"error,omitempty"`
}

func main() {
	genkitSrv := genkit.New()
	if err := googleai.Init(context.Background(), genkitSrv.Registry, nil); err != nil {
		log.Fatal(err)
	}

	r := &jsonschema.Reflector{
		AllowAdditionalProperties: false,
		DoNotReference:            true,
	}
	g := googleai.Model(genkitSrv.Registry, "gemini-1.5-pro")
	simpleGreetingPrompt, err := dotprompt.Define(genkitSrv.Registry,
		"simpleGreeting2", simpleGreetingPromptTemplate,
		dotprompt.Config{
			Model:        g,
			InputSchema:  r.Reflect(simpleGreetingInput{}),
			OutputFormat: ai.OutputFormatText,
		},
	)
	if err != nil {
		log.Fatal(err)
	}

	simpleGreetingFlow := genkit.DefineStreamingFlow(genkitSrv.Registry, "simpleGreeting", func(ctx context.Context, input *simpleGreetingInput, cb func(context.Context, string) error) (string, error) {
		var callback func(context.Context, *ai.GenerateResponseChunk) error
		if cb != nil {
			callback = func(ctx context.Context, c *ai.GenerateResponseChunk) error {
				return cb(ctx, c.Text())
			}
		}
		resp, err := simpleGreetingPrompt.Generate(ctx,
			genkitSrv.Registry,
			&dotprompt.PromptRequest{
				Variables: input,
			},
			callback,
		)
		if err != nil {
			return "", err
		}
		return resp.Text(), nil
	})

	greetingWithHistoryPrompt, err := dotprompt.Define(genkitSrv.Registry, "greetingWithHistory", greetingWithHistoryPromptTemplate,
		dotprompt.Config{
			Model:        g,
			InputSchema:  jsonschema.Reflect(customerTimeAndHistoryInput{}),
			OutputFormat: ai.OutputFormatText,
		},
	)
	if err != nil {
		log.Fatal(err)
	}

	greetingWithHistoryFlow := genkit.DefineFlow(genkitSrv.Registry, "greetingWithHistory", func(ctx context.Context, input *customerTimeAndHistoryInput) (string, error) {
		resp, err := greetingWithHistoryPrompt.Generate(ctx,
			genkitSrv.Registry,
			&dotprompt.PromptRequest{
				Variables: input,
			},
			nil,
		)
		if err != nil {
			return "", err
		}
		return resp.Text(), nil
	})

	simpleStructuredGreetingPrompt, err := dotprompt.Define(genkitSrv.Registry, "simpleStructuredGreeting", simpleStructuredGreetingPromptTemplate,
		dotprompt.Config{
			Model:        g,
			InputSchema:  r.Reflect(simpleGreetingInput{}),
			OutputFormat: ai.OutputFormatJSON,
			OutputSchema: r.Reflect(simpleGreetingOutput{}),
		},
	)
	if err != nil {
		log.Fatal(err)
	}

	genkit.DefineStreamingFlow(genkitSrv.Registry, "simpleStructuredGreeting", func(ctx context.Context, input *simpleGreetingInput, cb func(context.Context, string) error) (string, error) {
		var callback func(context.Context, *ai.GenerateResponseChunk) error
		if cb != nil {
			callback = func(ctx context.Context, c *ai.GenerateResponseChunk) error {
				return cb(ctx, c.Text())
			}
		}
		resp, err := simpleStructuredGreetingPrompt.Generate(ctx,
			genkitSrv.Registry,
			&dotprompt.PromptRequest{
				Variables: input,
			},
			callback,
		)
		if err != nil {
			return "", err
		}
		return resp.Text(), nil
	})

	genkit.DefineFlow(genkitSrv.Registry, "testAllCoffeeFlows", func(ctx context.Context, _ struct{}) (*testAllCoffeeFlowsOutput, error) {
		test1, err := simpleGreetingFlow.Run(ctx, &simpleGreetingInput{
			CustomerName: "Sam",
		})
		if err != nil {
			out := &testAllCoffeeFlowsOutput{
				Pass:  false,
				Error: err.Error(),
			}
			return out, nil
		}
		test2, err := greetingWithHistoryFlow.Run(ctx, &customerTimeAndHistoryInput{
			CustomerName:  "Sam",
			CurrentTime:   "09:45am",
			PreviousOrder: "Caramel Macchiato",
		})
		if err != nil {
			out := &testAllCoffeeFlowsOutput{
				Pass:  false,
				Error: err.Error(),
			}
			return out, nil
		}
		out := &testAllCoffeeFlowsOutput{
			Pass: true,
			Replies: []string{
				test1,
				test2,
			},
		}
		return out, nil
	})
	if err := genkitSrv.Init(context.Background(), nil); err != nil {
		log.Fatal(err)
	}
}
