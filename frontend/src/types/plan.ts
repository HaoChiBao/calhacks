// src/types/plan.ts

export type StrictPlanItem = {
  title: string;
  short_description: string;
  estimated_cost?: string;
  /** Optional photo URL returned by backend Places lookup */
  image_url?: string;
};

export type StrictPlanDays = StrictPlanItem[][];
