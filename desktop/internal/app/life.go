package app

import (
	"context"

	"github.com/deskwand/bot/desktop/internal/domain"
	"github.com/deskwand/bot/desktop/internal/lifeadmin"
)

// lifeClient mirrors walletClient: the ADMIN_TOKEN flow is shared with
// backups, so the home page works before the user ever opens the backup page.
func (s *Service) lifeClient(ctx context.Context, target domain.Target) (*lifeadmin.Client, error) {
	if s.endpoints == nil {
		return nil, s.serviceUnavailable()
	}
	endpoint, err := s.endpoints.Resolve(ctx, target)
	if err != nil {
		return nil, safeAppError(err)
	}
	client := lifeadmin.NewClient(endpoint.BaseURL, endpoint.Token, endpoint.HTTP)
	client.Locale = s.locale.Current
	return client, nil
}

// LifeVitals reads the deployed life ledger's vitals.
func (s *Service) LifeVitals() (LifeVitalsDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return LifeVitalsDTO{}, err
	}
	client, err := s.lifeClient(ctx, target)
	if err != nil {
		return LifeVitalsDTO{}, safeAppError(err)
	}
	vitals, err := client.Vitals(ctx)
	if err != nil {
		return LifeVitalsDTO{}, s.adminFailure(err)
	}
	sources := make([]LifeSourceDTO, 0, len(vitals.TopSources))
	for _, source := range vitals.TopSources {
		sources = append(sources, LifeSourceDTO{Source: source.Source, USD: source.USD})
	}
	return LifeVitalsDTO{
		BalanceUSD:        vitals.BalanceUSD,
		DailySpendUSD:     vitals.DailySpendUSD,
		RunwayDays:        vitals.RunwayDays,
		Tier:              vitals.Tier,
		MetabolismStarted: vitals.MetabolismStarted,
		Unpriced:          vitals.Unpriced,
		TopSources:        sources,
	}, nil
}
