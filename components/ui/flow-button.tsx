'use client';

import type { ComponentPropsWithoutRef } from 'react';
import { ArrowRight } from 'lucide-react';

export type FlowButtonProps = ComponentPropsWithoutRef<'button'> & { text?: string };

export function FlowButton({ text = 'Modern Button', className = '', type = 'button', ...props }: FlowButtonProps) {
  return (
    <button type={type} {...props} className={`flow-button group relative flex items-center gap-1 overflow-hidden rounded-[100px] border-[1.5px] border-[#333333]/40 bg-transparent px-8 py-3 text-sm font-semibold text-[#111111] cursor-pointer transition-all duration-[600ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-transparent hover:text-white hover:rounded-[12px] active:scale-[0.95] ${className}`}>
      <ArrowRight aria-hidden="true" className="flow-arrow-left absolute w-4 h-4 left-[-25%] stroke-[#111111] fill-none z-[9] group-hover:left-4 group-hover:stroke-white transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]" />
      <span className="relative z-[1] -translate-x-3 group-hover:translate-x-3 transition-all duration-[800ms] ease-out">{text}</span>
      <span aria-hidden="true" className="flow-fill absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 bg-[#111111] rounded-[50%] opacity-0 group-hover:w-[220px] group-hover:h-[220px] group-hover:opacity-100 transition-all duration-[800ms] ease-[cubic-bezier(0.19,1,0.22,1)]" />
      <ArrowRight aria-hidden="true" className="flow-arrow-right absolute w-4 h-4 right-4 stroke-[#111111] fill-none z-[9] group-hover:right-[-25%] group-hover:stroke-white transition-all duration-[800ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]" />
    </button>
  );
}
