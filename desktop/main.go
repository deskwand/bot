package main

import (
	"log"

	"github.com/egoist/mygo"
)

// AppInfo is the only service exposed to the page: the shell needs to prove
// that Go methods reach React through the generated TypeScript client.
type AppInfo struct{}

// Name returns the product name.
func (AppInfo) Name() string { return "DeskWand Bot" }

func main() {
	mygo.Bind(AppInfo{})

	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:     "DeskWand Bot",
			Width:     960,
			Height:    640,
			MinWidth:  480,
			MinHeight: 360,
			StateKey:  "main",
			URL:       "/",
		})
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
