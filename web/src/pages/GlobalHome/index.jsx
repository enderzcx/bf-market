/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import GlobalPublicHeader from '../../components/layout/GlobalPublicHeader';
import GlobalPublicFooter from '../../components/layout/GlobalPublicFooter';
import './global-home.css';
import { fujiExplorerTx } from '../../helpers/format';

gsap.registerPlugin(ScrollTrigger);

const COPY = {
  ratesUnit: 'BeefAPI 测试规则', ratesLink: '了解结算规则',
  brandHome: '伙伴中心首页', brand: '伙伴中心', primaryNavigation: '主要导航',
  title: '服务商伙伴中心', titleSecond: '链上佣金结算',
  heroCopy: '面向 new-api、sub2api 部署者，连接已有业务与伙伴佣金结算。BeefAPI 是首个测试接入案例，标准适配正在规划。',
  getStarted: '进入控制台', receiptAria: '2026年9月18日已完成的Fuji测试网结算案例',
  receipt: 'Fuji 测试网 · 已完成案例',
  receiptRows: [
    { model: '订单付款', tokens: 'x402', cost: '10 USDC' },
    { model: '返佣比例', tokens: '下单时锁定', cost: '10%' },
    { model: '佣金出款', tokens: '自动结算', cost: '1 USDC' },
    { model: '到账确认', tokens: '链上可查', cost: '已完成' },
    { model: '结算日期', tokens: '测试资金', cost: '09/18' },
  ],
  receiptTotalLabel: '本次返佣', receiptTotal: '1.00 USDC',
  routerTitle: '接入已有业务，', routerTitleSecond: '管好伙伴合作。',
  routerLead: '接入商家已有的订单与返佣规则。', routerLeadBreak: '确认佣金后，自动进入结算。',
  routerLeadSecond: '推广者查看收益与到账记录。', routerLeadSecondBreak: '每笔付款都能打开链上回执。',
  routerAria: '佣金结算流程示意', request: '结算流程示意',
  priceTitle: '金额算清楚。', priceTitleSecond: '合作更省心。',
  priceLead: '按实际支付金额计算返佣。', priceLeadBreak: '比例在下单时锁定。',
  priceLeadSecond: '规则变更只影响新订单。', priceLeadSecondBreak: '已经确认的佣金有据可查。',
  priceAria: '返佣规则说明',
  consoleTitle: '收益、付款、回执，一处查看。',
  consoleShotAlt: '伙伴中心商家控制台，使用已验收的Fuji历史测试订单展示',
  finalTitle: '每一笔佣金', finalTitleSecond: '都能核对到账', finalTitleThird: '伙伴中心 · BF Labs',
};
const RATE_ROWS = [
  { name: '实际支付', price: '按约定比例返佣', save: '' },
  { name: '比例锁定', price: '订单创建时确定', save: '' },
  { name: '规则调整', price: '仅影响新订单', save: '' },
  { name: '赠送与试用', price: '不计返佣', save: '' },
  { name: '收益转入', price: '不重复返佣', save: '' },
];
const ROUTER_FIELDS = ['确认佣金', '自动出款', '核对到账'];
const ROUTER_HOLD_MS = 1500;
const ROUTER_DELETE_MS = 26;
const ROUTER_TYPE_MS = 40;

const GlobalHomeGetStarted = ({ className = '' }) => (
  <Link
    className={['global-home-get-started', className].filter(Boolean).join(' ')}
    to='/console'
  >
    {COPY.getStarted}
  </Link>
);

const GlobalHomeRouterRequest = () => {
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState(ROUTER_FIELDS[0]);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    let timer = 0;
    let cancelled = false;
    const wait = (ms) =>
      new Promise((resolve) => {
        timer = window.setTimeout(resolve, ms);
      });

    const run = async () => {
      const current = ROUTER_FIELDS[index];
      const nextIndex = (index + 1) % ROUTER_FIELDS.length;
      const next = ROUTER_FIELDS[nextIndex];
      setTyped(current);
      setEditing(false);
      await wait(ROUTER_HOLD_MS);
      if (cancelled) return;
      setEditing(true);
      for (let length = current.length; length >= 0; length -= 1) {
        if (cancelled) return;
        setTyped(current.slice(0, length));
        await wait(ROUTER_DELETE_MS);
      }
      for (let length = 1; length <= next.length; length += 1) {
        if (cancelled) return;
        setTyped(next.slice(0, length));
        await wait(ROUTER_TYPE_MS);
      }
      if (cancelled) return;
      setEditing(false);
      setIndex(nextIndex);
    };

    run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [index]);


  return (
    <div className='global-home-router-stage' aria-label={COPY.routerAria}>
      <div className='global-home-router-panel' role='region'>
        <div className='global-home-router-bar' aria-hidden='true'>
          <i />
          <i />
          <i />
          <span>{COPY.request}</span>
        </div>
        <pre role='group' aria-label='确认佣金、自动出款、核对到账'>
          <code>
            <span className='global-home-router-slot' aria-hidden='true'>
              <span className='global-home-router-model'>{typed}</span>
              <span className='global-home-router-caret' />
            </span>
          </code>
        </pre>
      </div>
    </div>
  );
};

const GlobalHome = () => {
  useEffect(() => {
    document.title = '伙伴中心';
    document.documentElement.lang = 'zh-CN';
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }

    const root = document.querySelector('.global-home-page');
    if (!root) return undefined;
    const media = gsap.matchMedia();

    media.add('(min-width: 821px)', () => {
      const heroStage = root.querySelector('.global-home-product-stage');
      const receipt = root.querySelector('.global-home-receipt-object');
      if (heroStage && receipt) {
        gsap.fromTo(
          heroStage,
          { y: 42, opacity: 0 },
          { y: 0, opacity: 1, duration: 1.1, delay: 0.2, ease: 'power4.out' },
        );
        gsap.fromTo(
          receipt,
          { opacity: 0, filter: 'blur(8px)' },
          {
            opacity: 1,
            filter: 'blur(0px)',
            duration: 0.9,
            delay: 0.45,
            ease: 'power3.out',
          },
        );
        gsap.to(heroStage, {
          yPercent: -8,
          ease: 'none',
          scrollTrigger: {
            trigger: root.querySelector('.global-home-hero'),
            start: 'top top',
            end: 'bottom top',
            scrub: 1,
          },
        });
      }

      const routerPanel = root.querySelector('.global-home-router-panel');
      if (routerPanel) {
        gsap.to(routerPanel, {
          y: -24,
          rotateZ: -0.5,
          ease: 'none',
          scrollTrigger: {
            trigger: root.querySelector('#router'),
            start: 'top bottom',
            end: 'bottom top',
            scrub: 1,
          },
        });
      }

      gsap.fromTo(
        gsap.utils.toArray('.global-home-rates li', root),
        { x: 42, opacity: 0 },
        {
          x: 0,
          opacity: 1,
          duration: 0.65,
          stagger: 0.08,
          ease: 'power4.out',
          scrollTrigger: {
            trigger: root.querySelector('.global-home-rates'),
            start: 'top 78%',
            once: true,
          },
        },
      );

      const shotImage = root.querySelector('.global-home-shot img');
      if (shotImage) {
        gsap.fromTo(
          shotImage,
          { y: 28, scale: 1.035, clipPath: 'inset(8% 3% 8% 3% round 18px)' },
          {
            y: 0,
            scale: 1,
            clipPath: 'inset(0% 0% 0% 0% round 18px)',
            duration: 1.1,
            ease: 'power4.out',
            scrollTrigger: {
              trigger: root.querySelector('.global-home-shot'),
              start: 'top 82%',
              once: true,
            },
          },
        );
        gsap.to(shotImage, {
          yPercent: -3,
          ease: 'none',
          scrollTrigger: {
            trigger: root.querySelector('.global-home-shot'),
            start: 'top bottom',
            end: 'bottom top',
            scrub: 1,
          },
        });
      }
    });

    return () => media.revert();
  }, []);

  useEffect(() => {
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const targets = document.querySelectorAll(
      '.global-home-section-head, .global-home-router-copy, .global-home-router, .global-home-rates-copy, .global-home-rates, .global-home-shot',
    );
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    targets.forEach((target) => {
      target.classList.add('global-home-scrollfx');
      observer.observe(target);
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stage = document.querySelector('.global-home-product-stage');
    const receipt = document.querySelector('.global-home-receipt-object');
    if (!stage || !receipt) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }

    let frame = 0;
    let lastTime = performance.now();
    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };

    const updateTarget = (event) => {
      const bounds = stage.getBoundingClientRect();
      target.x = Math.max(
        -1,
        Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1),
      );
      target.y = Math.max(
        -1,
        Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1),
      );
    };

    const resetTarget = () => {
      target.x = 0;
      target.y = 0;
    };

    const tick = (time) => {
      const delta = Math.min(0.05, (time - lastTime) / 1000);
      lastTime = time;
      const blend = 1 - Math.exp(-9 * delta);
      current.x += (target.x - current.x) * blend;
      current.y += (target.y - current.y) * blend;
      receipt.style.setProperty('--receipt-tilt-y', `${current.x * 2.2}deg`);
      receipt.style.setProperty('--receipt-tilt-x', `${current.y * -2.4}deg`);
      receipt.style.setProperty('--receipt-tilt-z', `${current.x * 0.32}deg`);
      frame = window.requestAnimationFrame(tick);
    };

    stage.addEventListener('pointermove', updateTarget, { passive: true });
    stage.addEventListener('pointerleave', resetTarget, { passive: true });
    frame = window.requestAnimationFrame(tick);
    return () => {
      stage.removeEventListener('pointermove', updateTarget);
      stage.removeEventListener('pointerleave', resetTarget);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className='global-home-page'>
      <GlobalPublicHeader pathname='/' />

      <main id='page-top'>
        <section className='global-home-hero'>
          <div className='global-home-shell'>
            <p className='partner-home-network'>Avalanche Fuji 测试网 · 测试资金无实际价值</p>
            <h1 className='global-home-reveal global-home-delay-1'>
              <span className='partner-hero-line'>{COPY.title}</span>
              <span className='partner-hero-line'>{COPY.titleSecond}</span>
            </h1>
            <p className='global-home-hero-copy global-home-reveal global-home-delay-2'>
              {COPY.heroCopy}
            </p>
            <div className='global-home-actions global-home-reveal global-home-delay-3'>
              <GlobalHomeGetStarted />
            </div>

            <div
              className='global-home-product-stage global-home-reveal global-home-delay-4'
              aria-label={COPY.receiptAria}
            >
              <div className='global-home-stage-floor' />
              <div className='global-home-receipt-object'>
                <div className='global-home-receipt-shadow' />
                <div className='global-home-receipt-paper'>
                  <div className='global-home-receipt-inner'>
                    <div className='global-home-receipt-top'>
                      <span className='global-home-receipt-name'>
                        {COPY.receipt}
                      </span>
                    </div>
                    <div className='global-home-receipt-lines'>
                      {COPY.receiptRows.map((row) => (
                        <div
                          className='global-home-receipt-line'
                          key={row.model}
                        >
                          <strong>{row.model}</strong>
                          <span>{row.tokens}</span>
                          <b>{row.cost}</b>
                        </div>
                      ))}
                    </div>
                    <div className='global-home-receipt-bottom'>
                      <span>{COPY.receiptTotalLabel}</span>
                      <b className='global-home-receipt-total'>
                        {COPY.receiptTotal}
                      </b>
                    </div>
                    <a className='partner-public-proof' href={fujiExplorerTx('0x6f9843b7c2d14211c07ef6d539a625cd4c8b1c962426b49ada6b15ac8fdea23d')} target='_blank' rel='noopener noreferrer'>查看这笔链上出款</a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className='global-home-section global-home-shell' id='router'>
          <div className='global-home-section-head'>
            <h2>
              {COPY.routerTitle} <br />
              {COPY.routerTitleSecond}
            </h2>
          </div>

          <div className='global-home-router-layout'>
            <div className='global-home-router-copy'>
              <p>
                {COPY.routerLead} <br />
                {COPY.routerLeadBreak}
              </p>
              <p>
                {COPY.routerLeadSecond} <br />
                {COPY.routerLeadSecondBreak}
              </p>
              <p>从可核对的到账，走向有资金保障的佣金。<br /><Link to='/progress'>查看产品进展</Link></p>
            </div>
            <div className='global-home-router'>
              <GlobalHomeRouterRequest />
            </div>
          </div>
        </section>

        <section className='global-home-section global-home-shell' id='rates'>
          <div className='global-home-section-head'>
            <h2>
              {COPY.priceTitle} <br />
              {COPY.priceTitleSecond}
            </h2>
          </div>

          <div className='global-home-rates-layout'>
            <div className='global-home-rates-copy'>
              <p>
                {COPY.priceLead} <br />
                {COPY.priceLeadBreak}
              </p>
              <p>
                {COPY.priceLeadSecond} <br />
                {COPY.priceLeadSecondBreak}
              </p>
            </div>
            <div className='global-home-rates'>
              <p>{COPY.ratesUnit}</p>
              <ul aria-label={COPY.priceAria}>
                {RATE_ROWS.map((row) => (
                  <li key={row.name}>
                    <span className='global-home-rates-name'>{row.name}</span>
                    <span
                      className='global-home-rates-leader'
                      aria-hidden='true'
                    />
                    <span className='global-home-rates-price'>{row.price}</span>
                    <span className='global-home-rates-save'>{row.save}</span>
                  </li>
                ))}
              </ul>
              <a href='/partner/docs'>{COPY.ratesLink}</a>
            </div>
          </div>
        </section>

        <section className='global-home-section global-home-shell' id='console'>
          <div className='global-home-section-head'>
            <h2>{COPY.consoleTitle}</h2>
          </div>
          <figure className='global-home-shot'>
            <div className='global-home-shot-bar' aria-hidden='true'>
              <i />
              <i />
              <i />
            </div>
            <img
              src='/global/console-preview.png'
              alt={COPY.consoleShotAlt}
              loading='lazy'
              width='2360'
              height='1512'
            />
          </figure>
        </section>

        <section className='global-home-final'>
          <div className='global-home-shell'>
            <h2>
              {COPY.finalTitle} <br />
              {COPY.finalTitleSecond} <br />
              <span className='global-home-final-last'>
                {COPY.finalTitleThird}
              </span>
            </h2>
            <div className='global-home-actions'>
              <GlobalHomeGetStarted />
            </div>
          </div>
        </section>
      </main>

      <GlobalPublicFooter homeHref='/partner' />
    </div>
  );
};

export default GlobalHome;
