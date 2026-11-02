package main

import (
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The icon sources; mygo.json names iconPNG.
const iconPNG, iconSVG = "icon/icon.png", "icon/icon.svg"

// Satellite centre in 1024 space: 150 + 7.24*(87.9, 57.8).
const satelliteX, satelliteY = 786, 568

func TestAppIconPNG(t *testing.T) {
	f, err := os.Open(iconPNG)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 1024 || b.Dy() != 1024 {
		t.Fatalf("icon is %dx%d, want 1024x1024", b.Dx(), b.Dy())
	}
	at := func(x, y int) color.NRGBA {
		return color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA)
	}
	for _, p := range []image.Point{{0, 0}, {1023, 0}, {0, 1023}, {1023, 1023}} {
		if c := at(p.X, p.Y); c.A != 0 {
			t.Errorf("corner %v alpha = %d, want 0", p, c.A)
		}
	}
	if c := at(160, 860); c.A != 255 || int(c.B) <= int(c.R)+20 || c.B <= c.G {
		t.Errorf("base at (160,860) = %v, want opaque indigo", c)
	}
	warm := func(name string, x, y int) {
		if c := at(x, y); c.A != 255 || int(c.R) <= int(c.B)+40 || c.G <= c.B {
			t.Errorf("%s at (%d,%d) = %v, want opaque warm gold", name, x, y, c)
		}
	}
	warm("planet", 512, 540)
	warm("star", 309, 309)
	if c := at(satelliteX, satelliteY); int(c.G) <= int(c.R)+40 || int(c.B) <= int(c.R)+40 {
		t.Errorf("satellite at (%d,%d) = %v, want cold cyan", satelliteX, satelliteY, c)
	}
}

// The gap under the front of the orbit must reveal the base, not paint a
// rim of its own: next to the ring's left tip it matches the base beside it.
func TestAppIconRingHasNoHalo(t *testing.T) {
	f, err := os.Open(iconPNG)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	gap := color.NRGBAModel.Convert(img.At(192, 640)).(color.NRGBA)
	base := color.NRGBAModel.Convert(img.At(175, 640)).(color.NRGBA)
	diff := func(a, b uint8) int {
		if a > b {
			return int(a - b)
		}
		return int(b - a)
	}
	if diff(gap.R, base.R) > 6 || diff(gap.G, base.G) > 6 || diff(gap.B, base.B) > 6 {
		t.Errorf("gap at (192,640) = %v, base at (175,640) = %v: the ring has a visible rim", gap, base)
	}
}

// mygo ships everything in resources/ inside the app, so the icon sources
// live elsewhere and mygo.json names the PNG explicitly.
func TestAppIconStaysOutOfShippedResources(t *testing.T) {
	for _, name := range []string{"icon.png", "icon.svg"} {
		if _, err := os.Stat(filepath.Join("resources", name)); err == nil {
			t.Errorf("resources/%s would ship inside the app", name)
		}
	}
	raw, err := os.ReadFile("mygo.json")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Icon string `json:"icon"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	if config.Icon != iconPNG {
		t.Errorf("mygo.json icon = %q, want %q", config.Icon, iconPNG)
	}
}

func TestAppIconSVG(t *testing.T) {
	raw, err := os.ReadFile(iconSVG)
	if err != nil {
		t.Fatal(err)
	}
	svg := string(raw)
	for _, want := range []string{`viewBox="0 0 1024 1024"`,
		"#3f4a8a", "#232b5e", "#10153a", "#fff7d9", "#f2dfab", "#d6b77b", "#bff3ff", "#5cc4dc"} {
		if !strings.Contains(svg, want) {
			t.Errorf("icon.svg is missing %s", want)
		}
	}
	if strings.Contains(svg, "<filter") {
		t.Error("icon.svg must not use filters")
	}
}
