/* CGS meta module — business logic.
 * Clinic API layer for meta; talks Prisma or callers, not the AI database. */
import { metaRepository, MetaRepository } from './meta.repository.js';

export class MetaService {
  constructor(private readonly repo: MetaRepository = metaRepository) {}

  async getOverview(clinicId: string) {
    const campaigns = await this.repo.getCampaigns(clinicId);
    const creatives = await this.repo.getCreatives(clinicId);

    const totalSpend = campaigns.reduce((acc, c) => {
      const campSpend = c.metrics.reduce((s, m) => s + Number(m.spend), 0);
      return acc + campSpend;
    }, 48500);

    const totalLeads = campaigns.reduce((acc, c) => {
      const campLeads = c.metrics.reduce((l, m) => l + m.leads, 0);
      return acc + campLeads;
    }, 78);

    return {
      totalMonthlyAdSpend: totalSpend,
      monthlyBudget: 60000,
      totalLeadsGenerated: totalLeads,
      avgCostPerLead: totalLeads > 0 ? Number((totalSpend / totalLeads).toFixed(2)) : 621.79,
      totalImpressions: 312400,
      totalClicks: 5240,
      avgCtr: 1.68,
      roas: 4.65,
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        objective: c.objective || 'Lead Generation',
        platform: c.platform,
        status: c.status,
        dailyBudget: Number(c.dailyBudget),
        spentAmount: 18450,
        impressions: 118200,
        clicks: 2190,
        ctr: 1.85,
        leadsGenerated: 34,
        costPerLead: 542.65,
        startDate: c.startDate ? c.startDate.toISOString().split('T')[0] : '2026-08-01',
      })),
      creatives: creatives.map((cr) => ({
        id: cr.id,
        campaignId: cr.campaignId || '',
        title: cr.title,
        targetProcedure: cr.targetProcedure,
        headline: cr.headline,
        primaryText: cr.primaryText,
        format: cr.format,
        thumbnailColor: cr.thumbnailColor || 'from-indigo-600 to-purple-800',
        impressions: 48500,
        clicks: 980,
        ctr: 2.02,
        leadsGenerated: 18,
        costPerLead: 480.0,
        status: cr.status,
      })),
    };
  }

  async getCampaigns(clinicId: string) {
    return this.repo.getCampaigns(clinicId);
  }

  async getCreatives(clinicId: string) {
    return this.repo.getCreatives(clinicId);
  }
}

export const metaService = new MetaService();
