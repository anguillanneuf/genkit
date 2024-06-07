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

package dotprompt

import (
	"context"
	"fmt"
	"testing"

	"github.com/firebase/genkit/go/ai"
)

func testGenerate(ctx context.Context, req *ai.GenerateRequest, cb ai.ModelStreamingCallback) (*ai.GenerateResponse, error) {
	input := req.Messages[0].Content[0].Text
	output := fmt.Sprintf("AI reply to %q", input)

	r := &ai.GenerateResponse{
		Candidates: []*ai.Candidate{
			{
				Message: &ai.Message{
					Content: []*ai.Part{
						ai.NewTextPart(output),
					},
				},
			},
		},
		Request: req,
	}
	return r, nil
}

func TestExecute(t *testing.T) {
	testModel := ai.DefineModel("test", "test", nil, testGenerate)
	const promptName = "TestExecute"
	pa, err := Register(promptName, "Test prompt", Config{ModelAction: testModel})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := ai.Render(context.Background(), pa, &ai.PromptRequest{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Candidates) != 1 {
		t.Errorf("got %d candidates, want 1", len(resp.Candidates))
		if len(resp.Candidates) < 1 {
			t.FailNow()
		}
	}
	msg := resp.Candidates[0].Message
	if msg == nil {
		t.Fatal("response has candidate with no message")
	}
	if len(msg.Content) != 1 {
		t.Errorf("got %d message parts, want 1", len(msg.Content))
		if len(msg.Content) < 1 {
			t.FailNow()
		}
	}
	got := msg.Content[0].Text
	want := `AI reply to "Test prompt"`
	if got != want {
		t.Errorf("fake model replied with %q, want %q", got, want)
	}
}
