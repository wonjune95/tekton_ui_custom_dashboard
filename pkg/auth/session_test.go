/*
Copyright 2026 The Tekton Authors
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
		http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package auth

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"reflect"
	"testing"
)

var testKey = bytes.Repeat([]byte{7}, 32)

func TestSealerRoundTrip(t *testing.T) {
	s, err := newSealer(testKey)
	if err != nil {
		t.Fatal(err)
	}
	in := Session{User: "alice", Groups: []string{"org", "org:admins"}, Exp: 42}
	v, err := s.seal(sessionCookie, in)
	if err != nil {
		t.Fatal(err)
	}
	var out Session
	if err := s.open(sessionCookie, v, &out); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("got %+v, want %+v", out, in)
	}
}

func TestSealerRejectsTamperingAndWrongName(t *testing.T) {
	s, _ := newSealer(testKey)
	v, _ := s.seal(sessionCookie, Session{User: "alice"})

	raw, _ := base64.RawURLEncoding.DecodeString(v)
	raw[len(raw)-1] ^= 1
	var out Session
	if err := s.open(sessionCookie, base64.RawURLEncoding.EncodeToString(raw), &out); err == nil {
		t.Error("tampered value was accepted")
	}
	if err := s.open(flowCookie, v, &out); err == nil {
		t.Error("value sealed for another cookie was accepted")
	}
	if err := s.open(sessionCookie, "AA", &out); err == nil {
		t.Error("short value was accepted")
	}
}

func TestNewSealerKeyLength(t *testing.T) {
	if _, err := newSealer(testKey[:31]); err == nil {
		t.Error("31 byte key was accepted")
	}
}

func TestSafeReturn(t *testing.T) {
	for in, want := range map[string]string{
		"":                "/",
		"/":               "/",
		"/#/pipelineruns": "/#/pipelineruns",
		"//evil.com":      "/",
		"/\\evil.com":     "/",
		"https://evil":    "/",
		"evil":            "/",
	} {
		if got := safeReturn(in); got != want {
			t.Errorf("safeReturn(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStripIdentityHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("Authorization", "Bearer x")
	h.Set("Impersonate-User", "admin")
	h.Add("impersonate-group", "system:masters")
	h.Set("Impersonate-Uid", "1")
	h.Set("Impersonate-Extra-Scopes", "x")
	h.Set("Accept", "application/json")

	StripIdentityHeaders(h)

	if len(h) != 1 || h.Get("Accept") == "" {
		t.Fatalf("unexpected headers left: %v", h)
	}
}
