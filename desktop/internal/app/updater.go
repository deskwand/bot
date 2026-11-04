package app

// CheckClientUpdates opens the MyGo updater window. The window, its background
// checks, signature verification and installation all belong to the updater
// plugin; in a development build the window explains why the app cannot update
// itself.
func (s *Service) CheckClientUpdates() error {
	s.checkClientUpdates()
	return nil
}
