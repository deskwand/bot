package app

import (
	"context"

	"github.com/deskwand/bot/desktop/internal/botadmin"
	"github.com/deskwand/bot/desktop/internal/domain"
)

// botClient mirrors lifeClient: the ADMIN_TOKEN flow is shared with backups.
func (s *Service) botClient(ctx context.Context, target domain.Target) (*botadmin.Client, error) {
	if s.endpoints == nil {
		return nil, s.serviceUnavailable()
	}
	endpoint, err := s.endpoints.Resolve(ctx, target)
	if err != nil {
		return nil, safeAppError(err)
	}
	client := botadmin.NewClient(endpoint.BaseURL, endpoint.Token, endpoint.HTTP)
	client.Locale = s.locale.Current
	return client, nil
}

// Bots lists the bots this deployment's butler keeps. A read failure is an
// error, never an empty list: the page must be able to tell the two apart.
func (s *Service) Bots() (BotsDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return BotsDTO{}, err
	}
	client, err := s.botClient(ctx, target)
	if err != nil {
		return BotsDTO{}, err
	}
	bots, err := client.List(ctx)
	if err != nil {
		return BotsDTO{}, s.adminFailure(err)
	}
	out := BotsDTO{Bots: make([]BotDTO, 0, len(bots))}
	for _, bot := range bots {
		out.Bots = append(out.Bots, BotDTO{
			ID:          bot.ID,
			Name:        bot.Name,
			CreatedAt:   bot.CreatedAt,
			Meta:        botMetaDTO(bot.Meta),
			LastRun:     botRunPointer(bot.LastRun),
			Unavailable: bot.Unavailable,
		})
	}
	return out, nil
}

// BotDetail reads one bot's documents and recent runs.
func (s *Service) BotDetail(id string) (BotDetailDTO, error) {
	ctx := context.Background()
	target, err := s.managedTarget(ctx)
	if err != nil {
		return BotDetailDTO{}, err
	}
	client, err := s.botClient(ctx, target)
	if err != nil {
		return BotDetailDTO{}, err
	}
	detail, err := client.Detail(ctx, id)
	if err != nil {
		return BotDetailDTO{}, s.adminFailure(err)
	}
	out := BotDetailDTO{
		Meta: botMetaDTO(detail.Meta),
		Docs: make([]BotDocDTO, 0, len(detail.Docs)),
		Runs: make([]BotRunDTO, 0, len(detail.Runs)),
	}
	for _, doc := range detail.Docs {
		out.Docs = append(out.Docs, BotDocDTO{Name: doc.Name, Content: doc.Content})
	}
	for _, run := range detail.Runs {
		out.Runs = append(out.Runs, botRunDTO(run))
	}
	return out, nil
}

func botMetaDTO(meta *botadmin.BotMeta) *BotMetaDTO {
	if meta == nil {
		return nil
	}
	return &BotMetaDTO{
		BotID:               meta.BotID,
		Name:                meta.Name,
		Mission:             meta.Mission,
		Status:              meta.Status,
		NextWakeAt:          meta.NextWakeAt,
		DefaultIntervalMs:   meta.DefaultIntervalMs,
		CurrentTaskID:       meta.CurrentTaskID,
		ConsecutiveFailures: meta.ConsecutiveFailures,
		WakesDay:            meta.WakesDay,
		WakesCount:          meta.WakesCount,
		PendingSteer:        append([]string{}, meta.PendingSteer...),
		Earner:              meta.Earner,
		ManualWakeAt:        meta.ManualWakeAt,
		FinishReason:        meta.FinishReason,
	}
}

func botRunDTO(run botadmin.BotRun) BotRunDTO {
	return BotRunDTO{
		TaskID:    run.TaskID,
		StartedAt: run.StartedAt,
		EndedAt:   run.EndedAt,
		Outcome:   run.Outcome,
		Summary:   run.Summary,
		Note:      run.Note,
	}
}

func botRunPointer(run *botadmin.BotRun) *BotRunDTO {
	if run == nil {
		return nil
	}
	dto := botRunDTO(*run)
	return &dto
}
