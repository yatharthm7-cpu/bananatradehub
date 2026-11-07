'use client';

import TextBlockAnimation from '@/components/ui/text-block-animation';

export default function TextBlockAnimationDemo() {
  return <main className="min-h-screen grid place-items-center bg-[#0e0e12] text-white p-8">
    <div className="grid gap-10">
      <TextBlockAnimation blockColor="#d88ce9" animateOnScroll={false} delay={0.2} duration={0.8}>
        <h1 className="text-5xl font-black">Animated heading</h1>
      </TextBlockAnimation>
      <TextBlockAnimation blockColor="#9862ca" stagger={0.08}>
        <p>First line</p>
        <p>Second line</p>
        <p>Third line</p>
      </TextBlockAnimation>
    </div>
  </main>;
}
